# AgentCore Async Invocation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert synchronous AgentCore invocation to fire-and-forget async mode so long-running agents don't hit the 15-minute session timeout.

**Architecture:** `/invocations` returns immediately with `{ status: 'accepted' }`. Agent runs in background. All results (final reply, errors, session/usage metadata) flow through the existing SQS reply queue → reply-consumer path.

**Tech Stack:** TypeScript, Fastify, AWS SDK v3 (SQS, BedrockAgentCore), Claude Agent SDK

---

### Task 1: Extend shared types — ReplyMetadata + InvocationPayload.replyContext + InvocationResult.accepted

**Files:**
- Modify: `shared/src/types.ts`

**Step 1: Add ReplyMetadata interface and extend SqsTextReplyPayload**

In `shared/src/types.ts`, after the existing `SqsTextReplyPayload` interface (line 335), add `ReplyMetadata` and add the `metadata` field:

```typescript
// After line 331 (end of InvocationResult), add:
// --- nothing here, see below ---

// Find the SqsTextReplyPayload interface (line 335) and add metadata field.
// Find the InvocationResult interface (line 325) and add 'accepted' to status.
```

Concrete changes:

1. In `InvocationResult` (line 325), change `status: 'success' | 'error'` to `status: 'success' | 'error' | 'accepted'`.

2. Add `replyContext?: SqsReplyContext` to `InvocationPayload` (after line 288, before the closing `}`).

3. Add new `ReplyMetadata` interface before `SqsTextReplyPayload`:
```typescript
export interface ReplyMetadata {
  isFinalReply?: boolean;
  newSessionId?: string;
  tokensUsed?: number;
  model?: string;
  modelProvider?: string;
  userId?: string;
  sessionPath?: string;
  isError?: boolean;
}
```

4. Add `metadata?: ReplyMetadata` field to `SqsTextReplyPayload` (after `replyContext`).

**Step 2: Build shared to verify types compile**

Run: `npm run build -w shared`
Expected: Clean build, no errors.

**Step 3: Commit**

```bash
git add shared/src/types.ts
git commit -m "feat: add ReplyMetadata, replyContext on InvocationPayload, accepted status"
```

---

### Task 2: Add sendFinalReply and sendErrorReply to agent-runtime

**Files:**
- Modify: `agent-runtime/src/mcp-tools.ts`

**Step 1: Add sendFinalReply and sendErrorReply functions**

At the end of `agent-runtime/src/mcp-tools.ts` (after the validation helpers, before EOF), add two new exported functions.

These functions reuse the same SQS sending pattern as `sendMessage()` (line 57-82) but include `metadata` and work with `InvocationPayload` + `InvocationResult` instead of `McpToolContext`.

```typescript
import type { InvocationPayload, InvocationResult, ReplyMetadata } from '@clawbot/shared';

export async function sendFinalReply(
  payload: InvocationPayload,
  result: InvocationResult,
): Promise<void> {
  const replyPayload: SqsTextReplyPayload = {
    type: 'reply',
    botId: payload.botId,
    groupJid: payload.groupJid,
    channelType: payload.channelType,
    text: result.result!,
    timestamp: new Date().toISOString(),
    replyContext: payload.replyContext,
    metadata: {
      isFinalReply: true,
      newSessionId: result.newSessionId,
      tokensUsed: result.tokensUsed,
      model: payload.model,
      modelProvider: payload.modelProvider,
      userId: payload.userId,
      sessionPath: payload.sessionPath,
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
  const message = error instanceof Error ? error.message : String(error);
  const errorText = `Sorry, something went wrong while processing your message.\n\nError: ${message}`;

  const replyPayload: SqsTextReplyPayload = {
    type: 'reply',
    botId: payload.botId,
    groupJid: payload.groupJid,
    channelType: payload.channelType,
    text: errorText,
    timestamp: new Date().toISOString(),
    replyContext: payload.replyContext,
    metadata: {
      isError: true,
      userId: payload.userId,
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
```

Note: Add `InvocationPayload`, `InvocationResult`, and `ReplyMetadata` to the import from `@clawbot/shared` on line 35.

**Step 2: Build agent-runtime to verify**

Run: `npm run build -w agent-runtime`
Expected: Clean build, no errors.

**Step 3: Commit**

```bash
git add agent-runtime/src/mcp-tools.ts
git commit -m "feat: add sendFinalReply and sendErrorReply for async invocation"
```

---

### Task 3: Make agent-runtime /invocations async (fire-and-forget)

**Files:**
- Modify: `agent-runtime/src/server.ts`
- Modify: `agent-runtime/src/agent.ts` (remove setBusy/setIdle from handleInvocation)

**Step 1: Modify handleInvocation to not manage busy state**

In `agent-runtime/src/agent.ts` lines 199-209, `handleInvocation()` currently wraps `_handleInvocation()` with `setBusy()`/`setIdle()`. Remove the busy state management from here — it will move to `server.ts`:

Change:
```typescript
export async function handleInvocation(
  payload: InvocationPayload,
  logger: pino.Logger,
): Promise<InvocationResult> {
  setBusy();
  try {
    return await _handleInvocation(payload, logger);
  } finally {
    setIdle();
  }
}
```

To:
```typescript
export async function handleInvocation(
  payload: InvocationPayload,
  logger: pino.Logger,
): Promise<InvocationResult> {
  return _handleInvocation(payload, logger);
}
```

**Step 2: Rewrite /invocations endpoint in server.ts**

Replace the existing `/invocations` handler (lines 32-51) with the async fire-and-forget version:

```typescript
import { sendFinalReply, sendErrorReply } from './mcp-tools.js';
import { formatOutbound } from '@clawbot/shared';

// Agent execution endpoint — async fire-and-forget
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
    if (result.status === 'success' && result.result) {
      const text = result.result.trim();
      if (text !== 'NO_REPLY') {
        await sendFinalReply(payload, {
          ...result,
          result: formatOutbound(result.result),
        });
      }
    } else if (result.status === 'error') {
      await sendErrorReply(payload, new Error(result.error || 'Unknown agent error')).catch((e) => {
        logger.error(e, 'Failed to send error notification');
      });
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

**Step 3: Build agent-runtime to verify**

Run: `npm run build -w agent-runtime`
Expected: Clean build, no errors.

**Step 4: Commit**

```bash
git add agent-runtime/src/server.ts agent-runtime/src/agent.ts
git commit -m "feat: async fire-and-forget /invocations endpoint"
```

---

### Task 4: Simplify control-plane dispatcher (remove post-invoke handling)

**Files:**
- Modify: `control-plane/src/sqs/dispatcher.ts`

**Step 1: Pass replyContext into InvocationPayload**

In `dispatchMessage()` (around line 355-379 where `invocationPayload` is built), add `replyContext`:

```typescript
    const invocationPayload: InvocationPayload = {
      // ... existing fields ...
      ...(payload.replyContext && { replyContext: payload.replyContext }),
      // ... rest of existing fields ...
    };
```

**Step 2: Simplify dispatchMessage post-invoke logic**

Replace lines 392-485 (from `// 8. Invoke AgentCore` through `'Message dispatch complete'`) with:

```typescript
    // 8. Invoke AgentCore (async — returns immediately with ack)
    const result = await invokeAgent(invocationPayload, logger);

    if (result.status !== 'accepted') {
      // Ack-level failure (e.g. ARN not configured, AgentCore unreachable)
      logger.error({ botId: payload.botId, error: result.error }, 'Agent invocation rejected');
      await sendChannelReply(
        payload.botId,
        payload.groupJid,
        payload.channelType,
        `Failed to start processing: ${result.error || 'Unknown error'}`,
        logger,
        payload.replyContext,
      );
    }

    const duration = Date.now() - startTime;
    logger.info(
      {
        botId: payload.botId,
        groupJid: payload.groupJid,
        durationMs: duration,
        status: result.status,
      },
      'Message dispatch complete',
    );
```

This removes:
- Storing bot reply in DynamoDB (putMessage)
- Sending channel reply (sendChannelReply for success case)
- Updating session (putSession)
- Tracking usage (updateUserUsage)
- Error notification to user (now handled by agent-runtime)
- isSilentReply / formatOutbound logic

Keep the `finally` block unchanged (releases agent slot).

**Step 3: Simplify dispatchTask post-invoke logic**

Replace lines 565-612 (from `const result = await invokeAgent(invocationPayload, logger)` through `putSession`) with:

```typescript
  const result = await invokeAgent(invocationPayload, logger);

  if (result.status !== 'accepted') {
    logger.error(
      { botId: payload.botId, taskId: payload.taskId, error: result.error },
      'Scheduled task invocation rejected',
    );
  }

  logger.info(
    { botId: payload.botId, taskId: payload.taskId, status: result.status },
    'Scheduled task dispatch complete',
  );
```

**Step 4: Clean up unused imports**

After the simplification, these imports/usages can be removed from dispatcher.ts since they're no longer called in the post-invoke path:
- `formatOutbound` import from `@clawbot/shared` (line 10) — only if not used elsewhere in the file
- `Message` type import (line 25) — check if still used
- `putMessage` from dynamo imports (line 32) — only if not used elsewhere
- `putSession` from dynamo imports (line 33) — only if not used elsewhere
- `updateUserUsage` from dynamo imports (line 37) — only if not used elsewhere

Check each one before removing — `getSession` is still needed for model/provider change detection.

**Step 5: Build control-plane to verify**

Run: `npm run build -w control-plane`
Expected: Clean build, no errors.

**Step 6: Commit**

```bash
git add control-plane/src/sqs/dispatcher.ts
git commit -m "feat: simplify dispatcher — async invoke returns ack only"
```

---

### Task 5: Enhance reply-consumer with metadata processing

**Files:**
- Modify: `control-plane/src/sqs/reply-consumer.ts`

**Step 1: Add imports for DynamoDB operations**

Add imports at the top of `reply-consumer.ts`:

```typescript
import { formatOutbound } from '@clawbot/shared';
import type { SqsTextReplyPayload, ReplyMetadata } from '@clawbot/shared';
import {
  putMessage,
  putSession,
  updateUserUsage,
} from '../services/dynamo.js';
```

**Step 2: Add metadata processing after channel reply delivery**

After the existing text reply delivery (line 123: `await adapter.sendReply(ctx, payload.text);`), and before the message deletion (line 127), add metadata processing.

The new logic goes inside the `else` block (text reply path), after `sendReply`:

```typescript
          } else {
            // Format outbound text (strip internal tags)
            const formattedText = formatOutbound(payload.text);
            if (formattedText) {
              await adapter.sendReply(ctx, formattedText);
            }
          }

          // Process metadata for session/usage tracking (async invocation path)
          if (payload.type === 'reply' && (payload as SqsTextReplyPayload).metadata) {
            const meta = (payload as SqsTextReplyPayload).metadata!;
            await processReplyMetadata(payload.botId, payload.groupJid, payload.channelType, payload.text, payload.timestamp, meta, logger);
          }
```

**Step 3: Add processReplyMetadata function**

Add this function at the bottom of the file (before the closing of `replyLoop` or as a standalone function):

```typescript
async function processReplyMetadata(
  botId: string,
  groupJid: string,
  channelType: string,
  text: string,
  timestamp: string,
  meta: ReplyMetadata,
  logger: Logger,
): Promise<void> {
  try {
    // Store bot reply in DynamoDB (moved from dispatcher)
    if (meta.isFinalReply && text) {
      const formattedText = formatOutbound(text);
      if (formattedText) {
        await putMessage({
          botId,
          groupJid,
          timestamp,
          messageId: `bot-${Date.now()}`,
          sender: 'bot',
          senderName: 'bot',
          content: formattedText,
          isFromMe: true,
          isBotMessage: true,
          channelType: channelType as ChannelType,
          ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
        });
      }
    }

    // Update session
    if (meta.newSessionId) {
      await putSession({
        botId,
        groupJid,
        agentcoreSessionId: meta.newSessionId,
        s3SessionPath: meta.sessionPath || '',
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        lastModel: meta.model,
        lastModelProvider: meta.modelProvider as any,
      });
    }

    // Track token usage
    if (meta.tokensUsed && meta.userId) {
      await updateUserUsage(meta.userId, meta.tokensUsed).catch((err) =>
        logger.error(err, 'Failed to update user usage'),
      );
    }
  } catch (err) {
    logger.error({ err, botId, groupJid }, 'Failed to process reply metadata');
  }
}
```

**Step 4: Build control-plane to verify**

Run: `npm run build -w control-plane`
Expected: Clean build, no errors.

**Step 5: Run tests**

Run: `npm test -w control-plane`
Expected: All existing tests pass (reply-consumer changes are additive).

**Step 6: Commit**

```bash
git add control-plane/src/sqs/reply-consumer.ts
git commit -m "feat: reply-consumer handles session/usage metadata from async invocation"
```

---

### Task 6: Build all packages and verify end-to-end

**Files:** None (verification only)

**Step 1: Full workspace build**

Run: `npm run build --workspaces`
Expected: All 5 packages build cleanly.

**Step 2: Run all tests**

Run: `npm test -w control-plane`
Expected: All tests pass.

**Step 3: Type check all packages**

Run: `npm run typecheck -w shared && npm run typecheck -w control-plane && npm run typecheck -w agent-runtime`
Expected: No type errors.

**Step 4: Final commit (if any remaining changes)**

```bash
git status
# If clean, nothing to commit
```

---

## Key Design Notes for Implementer

1. **`replyContext` gap:** `InvocationPayload` currently has no `replyContext` field. Task 1 adds it. Task 4 passes it through from the SQS inbound payload. This is critical — without it, the async reply won't know Discord interaction tokens, Slack response URLs, etc.

2. **`formatOutbound`:** Currently called in dispatcher. After async, it must be called in TWO places: (a) agent-runtime's `sendFinalReply` (before sending to SQS), and (b) reply-consumer (before sending to channel adapter). We apply it in agent-runtime before SQS, so reply-consumer receives already-formatted text. But reply-consumer should also apply it for safety.

3. **Agent already calls `send_message` during execution:** Intermediate messages from the MCP `send_message` tool do NOT have `metadata` — reply-consumer handles them with existing logic (send to channel only). Only `sendFinalReply()` messages carry `metadata.isFinalReply: true`.

4. **`userId` in metadata:** Required for `updateUserUsage()`. Added to `ReplyMetadata` interface.

5. **`sessionPath` in metadata:** Required for `putSession()`. Added to `ReplyMetadata` interface.

6. **Build order:** `shared` → `agent-runtime` + `control-plane` (parallel). Build `shared` first since both depend on it.
