// ClawBot Cloud — Message Dispatcher
// Core message processing: the cloud equivalent of NanoClaw's message loop
// Receives SQS messages, loads context, invokes agent, stores reply, sends to channel

import type { Message as SQSMessage } from '@aws-sdk/client-sqs';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { formatOutbound } from '@clawbot/shared';
import type {
  ChannelType,
  InvocationPayload,
  InvocationResult,
  SqsInboundPayload,
  SqsPayload,
  SqsTaskPayload,
  Message,
} from '@clawbot/shared';
import { config } from '../config.js';
import {
  getGroup,
  ensureUser,
  putMessage,
  putSession,
  getTask,
  updateUserUsage,
  checkAndAcquireAgentSlot,
  releaseAgentSlot,
} from '../services/dynamo.js';
import { getCachedBot } from '../services/cached-lookups.js';
import { getRegistry } from '../adapters/registry.js';
import type { ReplyContext, ReplyOptions } from '@clawbot/shared/channel-adapter';
import type { Logger } from 'pino';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Check if agent result is a silent NO_REPLY (nothing to send) */
function isSilentReply(result: string | null | undefined): boolean {
  return result?.trim() === 'NO_REPLY';
}

// ── Main dispatch entry point ───────────────────────────────────────────────

export async function dispatch(
  sqsMessage: SQSMessage,
  logger: Logger,
): Promise<void> {
  const payload: SqsPayload = JSON.parse(sqsMessage.Body!);

  if (payload.type === 'inbound_message') {
    await dispatchMessage(payload, logger);
  } else if (payload.type === 'scheduled_task') {
    await dispatchTask(payload, logger);
  } else {
    logger.warn({ payload }, 'Unknown SQS payload type');
  }
}

// ── Inbound message dispatch ────────────────────────────────────────────────

async function dispatchMessage(
  payload: SqsInboundPayload,
  logger: Logger,
): Promise<void> {
  const startTime = Date.now();

  // 1. Load bot config
  const bot = await getCachedBot(payload.botId);
  if (!bot || bot.status !== 'active') {
    logger.info({ botId: payload.botId }, 'Bot not found or inactive, skipping dispatch');
    return;
  }

  // 2. Quota checks — load user (auto-provision with defaults if needed)
  const user = await ensureUser(payload.userId);
  if (user.usageTokens >= user.quota.maxMonthlyTokens) {
    logger.warn(
      { userId: payload.userId, usageTokens: user.usageTokens, maxMonthlyTokens: user.quota.maxMonthlyTokens },
      'User monthly token quota exceeded, dropping message',
    );
    // Send quota-exceeded notice to channel
    await sendChannelReply(
      payload.botId,
      payload.groupJid,
      payload.channelType,
      'Monthly usage quota exceeded. Please upgrade your plan or wait until next month.',
      logger,
      payload.replyContext,
    );
    return;
  }

  // 3. Acquire concurrency slot (atomic DynamoDB increment)
  const maxAgents = user.quota.maxConcurrentAgents;
  const slotAcquired = await checkAndAcquireAgentSlot(payload.userId, maxAgents);
  if (!slotAcquired) {
    // Don't delete the SQS message — let it retry after visibility timeout
    throw new Error('Concurrent agent limit reached, will retry');
  }

  try {
    // 4. Use message content from SQS payload (session history handled by Claude Code continue:true)
    const prompt = payload.content;

    // 5. Look up group record for isGroup flag
    const group = await getGroup(payload.botId, payload.groupJid);

    // 6. Build invocation payload
    const invocationPayload: InvocationPayload = {
      botId: payload.botId,
      botName: bot.name,
      groupJid: payload.groupJid,
      userId: payload.userId,
      channelType: payload.channelType,
      prompt,
      systemPrompt: bot.systemPrompt,
      model: bot.model,
      sessionPath: `${payload.userId}/${payload.botId}/sessions/${payload.groupJid}/`,
      memoryPaths: {
        botClaude: `${payload.userId}/${payload.botId}/CLAUDE.md`,
        groupClaude: `${payload.userId}/${payload.botId}/memory/${payload.groupJid}/CLAUDE.md`,
        learnings: `${payload.userId}/${payload.botId}/learnings/`,
      },
      isGroupChat: group?.isGroup,
      ...(payload.attachments && payload.attachments.length > 0 && {
        attachments: payload.attachments,
      }),
    };

    logger.info(
      { botId: payload.botId, groupJid: payload.groupJid },
      'Invoking agent',
    );

    // 7. Invoke AgentCore
    const result = await invokeAgent(invocationPayload, logger);

    // 8. Store bot reply in DynamoDB
    if (result.status === 'success' && result.result) {
      if (isSilentReply(result.result)) {
        logger.info({ botId: payload.botId, groupJid: payload.groupJid }, 'Agent returned NO_REPLY, skipping response');
      } else {
        const replyText = formatOutbound(result.result);
        if (replyText) {
          await putMessage({
            botId: payload.botId,
            groupJid: payload.groupJid,
            timestamp: new Date().toISOString(),
            messageId: `bot-${Date.now()}`,
            sender: bot.name,
            senderName: bot.name,
            content: replyText,
            isFromMe: true,
            isBotMessage: true,
            channelType: payload.channelType,
            ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
          });

          // 9. Send reply via channel adapter
          const durationMs = Date.now() - startTime;
          await sendChannelReply(
            payload.botId,
            payload.groupJid,
            payload.channelType,
            replyText,
            logger,
            payload.replyContext,
            {
              metadata: {
                durationMs,
                tokenCount: result.tokensUsed,
              },
            },
          );
        }
      }
    } else if (result.status === 'error') {
      logger.error(
        { botId: payload.botId, error: result.error },
        'Agent invocation failed',
      );
    }

    // 10. Update session
    if (result.newSessionId) {
      await putSession({
        botId: payload.botId,
        groupJid: payload.groupJid,
        agentcoreSessionId: result.newSessionId,
        s3SessionPath: invocationPayload.sessionPath,
        lastActiveAt: new Date().toISOString(),
        status: 'active',
      });
    }

    // 11. Track usage
    if (result.tokensUsed) {
      await updateUserUsage(payload.userId, result.tokensUsed).catch((err) =>
        logger.error(err, 'Failed to update user usage'),
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
  } finally {
    // Always release the agent slot, even on error
    await releaseAgentSlot(payload.userId).catch((err) =>
      logger.error(err, 'Failed to release agent slot'),
    );
  }
}

// ── Scheduled task dispatch ─────────────────────────────────────────────────

async function dispatchTask(
  payload: SqsTaskPayload,
  logger: Logger,
): Promise<void> {
  const bot = await getCachedBot(payload.botId);
  if (!bot || bot.status !== 'active') return;

  const task = await getTask(payload.botId, payload.taskId);
  if (!task || task.status !== 'active') return;

  // Look up group record to resolve channelType
  const group = await getGroup(payload.botId, payload.groupJid);
  const channelType: ChannelType = group?.channelType ?? 'telegram';

  logger.info(
    { botId: payload.botId, taskId: payload.taskId, channelType },
    'Dispatching scheduled task',
  );

  const invocationPayload: InvocationPayload = {
    botId: payload.botId,
    botName: bot.name,
    groupJid: payload.groupJid,
    userId: payload.userId,
    channelType,
    prompt: task.prompt,
    systemPrompt: bot.systemPrompt,
    model: bot.model,
    isScheduledTask: true,
    sessionPath: `${payload.userId}/${payload.botId}/sessions/${payload.groupJid}/`,
    memoryPaths: {
      botClaude: `${payload.userId}/${payload.botId}/CLAUDE.md`,
      groupClaude: `${payload.userId}/${payload.botId}/memory/${payload.groupJid}/CLAUDE.md`,
      learnings: `${payload.userId}/${payload.botId}/learnings/`,
    },
    isGroupChat: group?.isGroup,
  };

  const result = await invokeAgent(invocationPayload, logger);

  if (result.status === 'success' && result.result) {
    if (isSilentReply(result.result)) {
      logger.info({ botId: payload.botId, groupJid: payload.groupJid }, 'Agent returned NO_REPLY, skipping response');
    } else {
      const replyText = formatOutbound(result.result);
      if (replyText) {
        await putMessage({
          botId: payload.botId,
          groupJid: payload.groupJid,
          timestamp: new Date().toISOString(),
          messageId: `task-${payload.taskId}-${Date.now()}`,
          sender: bot.name,
          senderName: bot.name,
          content: replyText,
          isFromMe: true,
          isBotMessage: true,
          channelType,
          ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
        });

        // Send reply via channel API
        await sendChannelReply(
          payload.botId,
          payload.groupJid,
          channelType,
          replyText,
          logger,
        );
      }
    }
  }
}

// ── Agent Invocation (AgentCore Runtime via AWS SDK) ─────────────────────────

const agentcoreClient = new BedrockAgentCoreClient({ region: config.region });

export async function invokeAgent(
  payload: InvocationPayload,
  logger: Logger,
): Promise<InvocationResult> {
  const runtimeArn = config.agentcore.runtimeArn;
  if (!runtimeArn) {
    logger.error('AgentCore runtime ARN is not configured (AGENTCORE_RUNTIME_ARN)');
    return {
      status: 'error',
      result: null,
      error: 'AgentCore runtime ARN is not configured',
    };
  }

  logger.info(
    {
      botId: payload.botId,
      groupJid: payload.groupJid,
      promptLength: payload.prompt.length,
      isScheduledTask: payload.isScheduledTask,
    },
    'Invoking AgentCore runtime',
  );

  try {
    const response = await agentcoreClient.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: runtimeArn,
        payload: Buffer.from(JSON.stringify(payload)),
        contentType: 'application/json',
        accept: 'application/json',
        runtimeSessionId: `${payload.botId}---${payload.groupJid}`,
      }),
    );

    const resultText = (await response.response?.transformToString()) || '{}';
    const body = JSON.parse(resultText) as InvocationResult & { output?: InvocationResult };
    // Support both formats: {output: InvocationResult} and direct InvocationResult
    return body.output ?? body;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'AgentCore runtime invocation failed');
    return {
      status: 'error',
      result: null,
      error: `AgentCore invocation failed: ${message}`,
    };
  }
}

// ── Channel reply routing (via Adapter Registry) ────────────────────────────

async function sendChannelReply(
  botId: string,
  groupJid: string,
  channelType: string,
  text: string,
  logger: Logger,
  replyContext?: SqsInboundPayload['replyContext'],
  replyOpts?: ReplyOptions,
): Promise<void> {
  try {
    const registry = getRegistry();
    const adapter = registry.get(channelType);

    if (!adapter) {
      logger.warn({ botId, channelType }, 'No adapter registered for channel type');
      return;
    }

    const ctx: ReplyContext = {
      botId,
      groupJid,
      channelType: channelType as ChannelType,
      ...replyContext,
    };

    await adapter.sendReply(ctx, text, replyOpts);

    logger.info(
      { botId, groupJid, channelType },
      'Reply sent via adapter',
    );
  } catch (err) {
    logger.error(
      { err, botId, groupJid, channelType },
      'Failed to send channel reply',
    );
  }
}
