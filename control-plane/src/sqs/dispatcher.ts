// ClawBot Cloud — Message Dispatcher
// Core message processing: the cloud equivalent of NanoClaw's message loop
// Receives SQS messages, loads context, invokes agent, stores reply, sends to channel

import type { Message as SQSMessage } from '@aws-sdk/client-sqs';
import { formatMessages, formatOutbound } from '@clawbot/shared';
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
  getRecentMessages,
  putMessage,
  putSession,
  getTask,
  getChannelsByBot,
  updateUserUsage,
} from '../services/dynamo.js';
import { getCachedBot, getChannelCredentials } from '../services/cached-lookups.js';
import { sendChannelMessage } from '../channels/index.js';
import type { Logger } from 'pino';

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

  // 2. Query recent messages (last 50, filter out bot messages for context)
  const messages = await getRecentMessages(
    payload.botId,
    payload.groupJid,
    50,
  );
  const contextMessages = messages.filter((m) => !m.isBotMessage);

  // 3. Format into XML (preserving NanoClaw's format exactly)
  const prompt = formatMessages(
    contextMessages.map((m) => ({
      senderName: m.senderName,
      content: m.content,
      timestamp: m.timestamp,
    })),
    'UTC', // TODO: get timezone from bot/user config
  );

  // 4. Build invocation payload
  const invocationPayload: InvocationPayload = {
    botId: payload.botId,
    botName: bot.name,
    groupJid: payload.groupJid,
    userId: payload.userId,
    channelType: payload.channelType,
    prompt,
    systemPrompt: bot.systemPrompt,
    sessionPath: `${payload.userId}/${payload.botId}/sessions/${payload.groupJid}/`,
    memoryPaths: {
      shared: `${payload.userId}/shared/CLAUDE.md`,
      botGlobal: `${payload.userId}/${payload.botId}/memory/global/CLAUDE.md`,
      group: `${payload.userId}/${payload.botId}/memory/${payload.groupJid}/CLAUDE.md`,
    },
  };

  logger.info(
    { botId: payload.botId, groupJid: payload.groupJid },
    'Invoking agent',
  );

  // 5. Invoke AgentCore
  const result = await invokeAgent(invocationPayload, logger);

  // 6. Store bot reply in DynamoDB
  if (result.status === 'success' && result.result) {
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

      // 7. Send reply via channel API
      await sendChannelReply(
        payload.botId,
        payload.groupJid,
        payload.channelType,
        replyText,
        logger,
      );
    }
  } else if (result.status === 'error') {
    logger.error(
      { botId: payload.botId, error: result.error },
      'Agent invocation failed',
    );
  }

  // 8. Update session
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

  // 9. Track usage
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
    isScheduledTask: true,
    sessionPath: `${payload.userId}/${payload.botId}/sessions/${payload.groupJid}/`,
    memoryPaths: {
      shared: `${payload.userId}/shared/CLAUDE.md`,
      botGlobal: `${payload.userId}/${payload.botId}/memory/global/CLAUDE.md`,
      group: `${payload.userId}/${payload.botId}/memory/${payload.groupJid}/CLAUDE.md`,
    },
  };

  const result = await invokeAgent(invocationPayload, logger);

  if (result.status === 'success' && result.result) {
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

// ── Agent Invocation (AgentCore Runtime) ─────────────────────────────────────

const AGENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — agent turns can be long

export async function invokeAgent(
  payload: InvocationPayload,
  logger: Logger,
): Promise<InvocationResult> {
  const runtimeUrl = config.agentcore.runtimeArn;
  if (!runtimeUrl) {
    logger.error('AgentCore runtime URL is not configured (AGENTCORE_RUNTIME_ARN)');
    return {
      status: 'error',
      result: null,
      error: 'AgentCore runtime URL is not configured',
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

  try {
    const response = await fetch(runtimeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'no body');
      logger.error(
        { status: response.status, errorBody },
        'AgentCore runtime returned non-OK status',
      );
      return {
        status: 'error',
        result: null,
        error: `AgentCore returned HTTP ${response.status}: ${errorBody}`,
      };
    }

    const body = (await response.json()) as { output: InvocationResult };
    return body.output;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'AgentCore runtime invocation failed');
    return {
      status: 'error',
      result: null,
      error: `AgentCore invocation failed: ${message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Channel reply routing ───────────────────────────────────────────────────

async function sendChannelReply(
  botId: string,
  groupJid: string,
  channelType: string,
  text: string,
  logger: Logger,
): Promise<void> {
  try {
    // Load channel config for this bot + channel type
    const channels = await getChannelsByBot(botId);
    const channel = channels.find((ch) => ch.channelType === channelType);
    if (!channel) {
      logger.warn(
        { botId, channelType },
        'No channel configured for reply routing',
      );
      return;
    }

    // Load credentials
    const creds = await getChannelCredentials(channel.credentialSecretArn);

    // Extract chat ID from groupJid (format: "tg:123456", "dc:789", "sl:C01234")
    const chatId = groupJid.split(':')[1];
    if (!chatId) {
      logger.error({ groupJid }, 'Could not extract chatId from groupJid');
      return;
    }

    // Send via channel client
    await sendChannelMessage(
      channelType as Message['channelType'],
      creds,
      chatId,
      text,
    );

    logger.info(
      { botId, groupJid, channelType },
      'Reply sent via channel',
    );
  } catch (err) {
    logger.error(
      { err, botId, groupJid, channelType },
      'Failed to send channel reply',
    );
  }
}
