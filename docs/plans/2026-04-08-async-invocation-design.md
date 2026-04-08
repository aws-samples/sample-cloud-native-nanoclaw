# AgentCore Async Invocation Design

**Date:** 2026-04-08  
**Status:** Draft  
**Problem:** Control Plane synchronously awaits AgentCore `InvokeAgentRuntimeCommand`, blocking for up to 15 minutes. Long-running agent tasks hit the AgentCore session timeout and fail.

## Background

AgentCore terminates sessions after 15 minutes of `/ping` inactivity. When the agent-runtime's single-threaded Fastify server blocks on `handleInvocation()`, it cannot respond to `/ping`, causing session termination on long tasks.

AWS AgentCore's official async pattern: the `/invocations` endpoint returns immediately, background work continues, `/ping` returns `HealthyBusy` during processing and `Healthy` when idle.

## Solution: Fire-and-Forget with MCP Reply Channel

### Architecture Change

**Before (synchronous):**
```
SQS msg → dispatcher.invokeAgent() ──await 5~15min──→ InvocationResult
         → store reply in DynamoDB
         → sendChannelReply()
         → putSession()
         → updateUserUsage()
         → delete SQS message
```

**After (async fire-and-forget):**
```
SQS msg → dispatcher.invokeAgent() ──await <1s──→ { status: 'accepted' }
         → delete SQS message ✓ done

(background in agent-runtime)
  → handleInvocation()
  → Claude Agent SDK query() — no time limit
  → /ping returns HealthyBusy during processing
  → on completion: sendFinalReply() via SQS reply queue
  → on error: sendErrorReply() via SQS reply queue

(control-plane reply-consumer)
  → receives reply from SQS reply queue
  → sendChannelReply() to user
  → putMessage() store in DynamoDB
  → putSession() if metadata.newSessionId present
  → updateUserUsage() if metadata.tokensUsed present
```

### Key Design Decisions

1. **Reply channel:** Reuse existing MCP `send_message` → SQS reply queue → reply-consumer path (already proven for intermediate messages)
2. **Async model:** Fire-and-forget — `/invocations` returns `{ status: 'accepted' }` immediately, all results go through SQS
3. **Error notification:** Errors sent to user via same `send_message` SQS channel
4. **Session/usage tracking:** Moved from dispatcher to reply-consumer via message metadata
5. **Final reply sender:** Reuse MCP `send_message` SQS sending logic in agent-runtime

## Detailed Changes

### 1. `shared/src/types.ts` — Type Extensions

Add `ReplyMetadata` interface and extend `SqsTextReplyPayload`:

```typescript
export interface ReplyMetadata {
  isFinalReply?: boolean;
  newSessionId?: string;
  tokensUsed?: number;
  model?: string;
  modelProvider?: string;
  isError?: boolean;
}

export interface SqsTextReplyPayload {
  type: 'reply';
  botId: string;
  groupJid: string;
  channelType: ChannelType;
  text: string;
  timestamp: string;
  replyContext?: SqsReplyContext;
  metadata?: ReplyMetadata;  // NEW
}
```

Extend `InvocationResult` to support async ack:

```typescript
export interface InvocationResult {
  status: 'success' | 'error' | 'accepted';  // 'accepted' = async ack
  result: string | null;
  newSessionId?: string;
  tokensUsed?: number;
  error?: string;
}
```

### 2. `agent-runtime/src/server.ts` — Async /invocations

```typescript
app.post<{ Body: InvocationPayload }>('/invocations', async (request, reply) => {
  const payload = request.body;
  logger.info({ botId: payload.botId, groupJid: payload.groupJid }, 'Invocation received');
  
  setBusy();
  
  // Fire-and-forget: run in background, respond immediately
  runInBackground(payload).catch((err) => {
    logger.error(err, 'Background invocation crashed unexpectedly');
  });
  
  return reply.send({ status: 'accepted' });
});

async function runInBackground(payload: InvocationPayload): Promise<void> {
  try {
    const result = await handleInvocation(payload, logger);
    
    // Send final reply via SQS (same channel as MCP send_message)
    if (result.status === 'success' && result.result && !isSilentReply(result.result)) {
      await sendFinalReply(payload, result);
    }
  } catch (error) {
    logger.error(error, 'Background invocation failed');
    await sendErrorReply(payload, error).catch((e) => {
      logger.error(e, 'Failed to send error notification');
    });
  } finally {
    setIdle();
  }
}
```

### 3. `agent-runtime/src/mcp-tools.ts` — New sendFinalReply / sendErrorReply

Add exported functions that reuse the existing SQS sending logic:

```typescript
export async function sendFinalReply(
  payload: InvocationPayload,
  result: InvocationResult,
): Promise<void> {
  const replyPayload: SqsTextReplyPayload = {
    type: 'reply',
    botId: payload.botId,
    groupJid: payload.groupJid,
    channelType: payload.channelType as ChannelType,
    text: result.result!,
    timestamp: new Date().toISOString(),
    replyContext: payload.replyContext,
    metadata: {
      isFinalReply: true,
      newSessionId: result.newSessionId,
      tokensUsed: result.tokensUsed,
      model: payload.model,
      modelProvider: payload.modelProvider,
    },
  };

  const sqs = new SQSClient({});
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: REPLY_QUEUE_URL,
      MessageBody: JSON.stringify(replyPayload),
    }),
  );
}

export async function sendErrorReply(
  payload: InvocationPayload,
  error: unknown,
): Promise<void> {
  const errorText = `Sorry, something went wrong while processing your message.\n\nError: ${error instanceof Error ? error.message : 'Unknown error'}`;
  
  const replyPayload: SqsTextReplyPayload = {
    type: 'reply',
    botId: payload.botId,
    groupJid: payload.groupJid,
    channelType: payload.channelType as ChannelType,
    text: errorText,
    timestamp: new Date().toISOString(),
    replyContext: payload.replyContext,
    metadata: { isError: true },
  };

  const sqs = new SQSClient({});
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: REPLY_QUEUE_URL,
      MessageBody: JSON.stringify(replyPayload),
    }),
  );
}
```

### 4. `control-plane/src/sqs/dispatcher.ts` — Simplify Post-Invocation

In `dispatchMessage()` (and `dispatchTask()`), after `invokeAgent()`:

**Remove:**
- Store reply in DynamoDB (putMessage)
- Send channel reply (sendChannelReply)
- Update session (putSession)
- Track usage (updateUserUsage)

**Keep:**
- Check ack status — log error if `status !== 'accepted'`
- Release agent slot (finally block)
- Log dispatch completion

```typescript
// 8. Invoke AgentCore (async — returns immediately)
const result = await invokeAgent(invocationPayload, logger);

if (result.status !== 'accepted') {
  logger.error({ botId: payload.botId, error: result.error }, 'Agent invocation rejected');
  // Notify user of immediate failure (ack-level error, not agent error)
  await sendChannelReply(payload.botId, payload.groupJid, payload.channelType,
    `Failed to start processing: ${result.error || 'Unknown error'}`,
    logger, payload.replyContext);
}

const duration = Date.now() - startTime;
logger.info({ botId: payload.botId, durationMs: duration, status: result.status }, 'Message dispatch complete');
```

### 5. `control-plane/src/sqs/reply-consumer.ts` — Metadata Processing

After sending the channel reply (existing logic), add metadata handling:

```typescript
// Existing: send reply to channel
if (payload.type === 'reply') {
  await adapter.sendReply(ctx, payload.text);
}

// NEW: process metadata for session/usage tracking
if (payload.metadata) {
  const { newSessionId, tokensUsed, model, modelProvider, isFinalReply } = payload.metadata;
  
  // Store bot reply in DynamoDB (moved from dispatcher)
  if (isFinalReply && payload.text) {
    await putMessage({
      botId: payload.botId,
      groupJid: payload.groupJid,
      timestamp: payload.timestamp,
      messageId: `bot-${Date.now()}`,
      sender: 'bot',
      senderName: 'bot',
      content: payload.text,
      isFromMe: true,
      isBotMessage: true,
      channelType: payload.channelType,
      ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
    });
  }
  
  // Update session
  if (newSessionId) {
    await putSession({
      botId: payload.botId,
      groupJid: payload.groupJid,
      agentcoreSessionId: newSessionId,
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      lastModel: model,
      lastModelProvider: modelProvider,
    });
  }
  
  // Track token usage
  if (tokensUsed) {
    // Need userId — add to metadata or look up from bot
    await updateUserUsage(userId, tokensUsed).catch((err) =>
      logger.error(err, 'Failed to update user usage'));
  }
}
```

**Note:** `userId` is not in the current reply payload. Two options:
- Add `userId` to `ReplyMetadata` (simplest)
- Look up from DynamoDB bot record (extra read)

→ Recommend adding `userId` to `ReplyMetadata`.

### 6. Handling Edge Cases

**Agent already sends intermediate replies via MCP send_message:**
- These messages do NOT have `metadata.isFinalReply` — reply-consumer handles them as before (send to channel only, no DynamoDB/session/usage update)
- Only the final reply from `sendFinalReply()` triggers the full processing path

**Agent crashes mid-execution:**
- `runInBackground()` catch block sends error notification to user
- If the process itself dies (OOM, segfault), AgentCore will terminate the session
- User receives no notification in this case — acceptable for now (can add DynamoDB-based timeout detection later)

**Duplicate message delivery:**
- SQS reply queue is Standard (not FIFO) — duplicates possible
- `putSession()` and `updateUserUsage()` are idempotent
- `putMessage()` uses timestamp-based messageId — minor risk of duplicate stored messages (acceptable)

**Agent slot release:**
- Currently released in dispatcher's finally block — still works since ack is fast
- Agent slot represents "dispatched to AgentCore" not "agent finished" — semantics unchanged

## Migration Plan

1. Deploy `shared` types first (backward compatible — new fields are optional)
2. Deploy `agent-runtime` with async `/invocations` and `sendFinalReply`/`sendErrorReply`
3. Deploy `control-plane` with simplified dispatcher and enhanced reply-consumer
4. Steps 2 and 3 can be deployed together since the reply-consumer already ignores unknown fields

## Files Changed

| File | Change |
|------|--------|
| `shared/src/types.ts` | Add `ReplyMetadata`, extend `SqsTextReplyPayload`, extend `InvocationResult` |
| `agent-runtime/src/server.ts` | Async `/invocations` with fire-and-forget background task |
| `agent-runtime/src/mcp-tools.ts` | Add `sendFinalReply()` and `sendErrorReply()` exports |
| `control-plane/src/sqs/dispatcher.ts` | Remove post-invocation reply/session/usage handling |
| `control-plane/src/sqs/reply-consumer.ts` | Add metadata processing for session/usage/message storage |
