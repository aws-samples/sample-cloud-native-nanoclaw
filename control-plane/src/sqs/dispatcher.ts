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
  FeishuInvocationConfig,
  InvocationPayload,
  InvocationResult,
  SqsInboundPayload,
  SqsPayload,
  SqsTaskPayload,
  Message,
} from '@clawbot/shared';
import type { ModelProvider, ProviderType, Session } from '@clawbot/shared';
import { config } from '../config.js';
import {
  getGroup,
  ensureUser,
  putMessage,
  putSession,
  getSession,
  getTask,
  getRecentMessages,
  updateUserUsage,
  checkAndAcquireAgentSlot,
  releaseAgentSlot,
  getChannelsByBot,
  getProvider,
  getSkill,
} from '../services/dynamo.js';
import { getProviderApiKey, getProxyRules } from '../services/secrets.js';
import { getCachedBot } from '../services/cached-lookups.js';
import type { Bot } from '@clawbot/shared';
import { getRegistry } from '../adapters/registry.js';
import type { ReplyContext, ReplyOptions } from '@clawbot/shared/channel-adapter';
import type { Logger } from 'pino';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Detect model/provider change that requires session reset */
export function shouldResetSession(
  session: Session | null,
  currentModel: string | undefined,
  currentProvider: ModelProvider | undefined,
): boolean {
  if (!session) return false;
  if (!session.lastModel && !session.lastModelProvider) return false;
  return session.lastModel !== currentModel || session.lastModelProvider !== currentProvider;
}

/** Check if agent result is a silent NO_REPLY (nothing to send) */
function isSilentReply(result: string | null | undefined): boolean {
  return result?.trim() === 'NO_REPLY';
}

/** Max recent messages to include as group chat context */
const GROUP_CONTEXT_LIMIT = 20;
/** Max characters per message in group context (prevent token budget blowup) */
const MAX_CONTEXT_MSG_CHARS = 500;

/**
 * Build group chat context from recent DynamoDB messages.
 * Returns formatted chat log to prepend to the prompt, or empty string for DMs.
 */
async function buildGroupChatContext(
  botId: string,
  groupJid: string,
  isGroupChat: boolean,
  currentMessageId: string,
  logger: Logger,
): Promise<string> {
  if (!isGroupChat) return '';

  try {
    const messages = await getRecentMessages(botId, groupJid, GROUP_CONTEXT_LIMIT + 1);
    // Exclude the current message (it's already the prompt) — messages are chronological
    const context = messages.filter(m => m.messageId !== currentMessageId);
    if (context.length === 0) return '';

    const lines = context.map(m => {
      const name = m.senderName || m.sender || 'Unknown';
      const who = m.isBotMessage ? `[Bot] ${name}` : name;
      const time = m.timestamp.slice(11, 16); // "HH:MM"
      const text = m.content.length > MAX_CONTEXT_MSG_CHARS
        ? m.content.slice(0, MAX_CONTEXT_MSG_CHARS) + '...(truncated)'
        : m.content;
      return `[${time}] ${who}: ${text}`;
    });

    return `[Recent group chat (last ${context.length} messages)]\n${lines.join('\n')}\n---\n`;
  } catch (err) {
    logger.warn({ err, botId, groupJid }, 'Failed to build group chat context');
    return '';
  }
}

/**
 * Build FeishuInvocationConfig when the channel is 'feishu'.
 * Looks up the feishu channel for this bot and returns the credential ARN
 * and tool config so the agent runtime can load secrets and register tools.
 */
async function buildFeishuConfig(
  botId: string,
  channelType: ChannelType,
  logger: Logger,
): Promise<FeishuInvocationConfig | undefined> {
  if (channelType !== 'feishu') return undefined;

  try {
    const channels = await getChannelsByBot(botId);
    const feishuChannel = channels.find((c) => c.channelType === 'feishu');
    if (!feishuChannel) return undefined;

    // Tool config from channel config (defaults: doc + wiki enabled, drive + perm require opt-in)
    const toolConfig = (feishuChannel.config?.tools ?? {}) as Partial<
      Record<'doc' | 'wiki' | 'drive' | 'perm', boolean>
    >;

    return {
      credentialSecretArn: feishuChannel.credentialSecretArn,
      domain: (feishuChannel.config?.domain as string) ?? 'feishu',
      tools: {
        doc: toolConfig.doc !== false,
        wiki: toolConfig.wiki !== false,
        drive: toolConfig.drive === true,
        perm: toolConfig.perm === true,
      },
    };
  } catch (err) {
    logger.warn({ err, botId }, 'Failed to build feishu config for invocation');
    return undefined;
  }
}

async function resolveProviderCredentials(
  bot: { providerId?: string; modelId?: string; model?: string; modelProvider?: ModelProvider; botId: string },
  userId: string,
  logger: Logger,
): Promise<{ model?: string; modelProvider?: ModelProvider; providerType?: ProviderType; anthropicApiKey?: string; anthropicBaseUrl?: string }> {
  // New path: use providerId from providers table
  if (bot.providerId) {
    try {
      const provider = await getProvider(bot.providerId);
      if (!provider) {
        logger.warn({ providerId: bot.providerId, botId: bot.botId }, 'Provider not found, falling back to bedrock');
        return {};
      }

      const result: Record<string, unknown> = {
        model: bot.modelId,
        providerType: provider.providerType,
      };

      if (provider.providerType === 'anthropic-compatible-api') {
        result.modelProvider = 'anthropic-api' as ModelProvider;
        if (provider.hasApiKey) {
          const apiKey = await getProviderApiKey(provider.providerId);
          if (apiKey) {
            result.anthropicApiKey = apiKey;
          }
        }
        if (provider.baseUrl) {
          result.anthropicBaseUrl = provider.baseUrl;
        }
      } else {
        result.modelProvider = 'bedrock' as ModelProvider;
      }

      return result as ReturnType<typeof resolveProviderCredentials> extends Promise<infer T> ? T : never;
    } catch (err) {
      logger.error({ err, providerId: bot.providerId }, 'Failed to resolve provider, falling back to bedrock');
      return {};
    }
  }

  // Legacy path: bot still has old modelProvider field (migration-period fallback).
  // Note: API key will NOT be resolved here — bots should be migrated to use a provider.
  if (bot.modelProvider === 'anthropic-api') {
    logger.warn({ botId: bot.botId }, 'Bot uses legacy modelProvider=anthropic-api without providerId — API key will not be resolved. Migrate bot to use a provider.');
    return { modelProvider: 'anthropic-api' };
  }

  return {};
}

// ── Default Proxy Rules ─────────────────────────────────────────────────────

/** Built-in proxy rules that are always available. User-configured secrets fill them in. */
const DEFAULT_PROXY_RULES = [
  { prefix: '/anthropic', target: 'https://api.anthropic.com', authType: 'api-key' as const, headerName: 'x-api-key' },
  { prefix: '/openai', target: 'https://api.openai.com', authType: 'bearer' as const },
  { prefix: '/github', target: 'https://api.github.com', authType: 'bearer' as const },
  { prefix: '/jira', target: 'https://your-domain.atlassian.net', authType: 'basic' as const },
  { prefix: '/google-ai', target: 'https://generativelanguage.googleapis.com', authType: 'api-key' as const, headerName: 'x-goog-api-key' },
];

/**
 * Build merged proxy rules: start with defaults, overlay user-configured rules.
 * The Anthropic rule is auto-populated from the existing Anthropic API key config.
 * Only rules with a secret value are included (no point proxying without auth).
 */
async function buildProxyRules(
  userId: string,
  anthropicApiKey: string | undefined,
  anthropicBaseUrl: string | undefined,
): Promise<Array<{ prefix: string; target: string; authType: 'bearer' | 'api-key' | 'basic'; headerName?: string; value: string }>> {
  const userRules = await getProxyRules(userId);

  // Build a map of user rules by prefix (user rules override defaults)
  const ruleMap = new Map<string, { prefix: string; target: string; authType: 'bearer' | 'api-key' | 'basic'; headerName?: string; value: string }>();

  // 1. Seed with defaults (no value yet)
  for (const def of DEFAULT_PROXY_RULES) {
    ruleMap.set(def.prefix, { ...def, value: '' });
  }

  // 2. Auto-fill Anthropic from existing config
  if (anthropicApiKey) {
    const existing = ruleMap.get('/anthropic')!;
    // Normalize base URL: strip trailing API paths that the SDK appends itself
    let target = anthropicBaseUrl || existing.target;
    target = target.replace(/\/v1\/?(messages\/?)?$/, '').replace(/\/+$/, '');
    ruleMap.set('/anthropic', {
      ...existing,
      target,
      value: anthropicApiKey,
    });
  }

  // 3. Overlay user-configured rules (these have explicit secrets)
  for (const ur of userRules) {
    ruleMap.set(ur.prefix, {
      prefix: ur.prefix,
      target: ur.target,
      authType: ur.authType,
      headerName: ur.headerName,
      value: ur.value,
    });
  }

  // 4. Filter out rules without a secret — no point proxying without auth
  return [...ruleMap.values()].filter((r) => r.value);
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
    // 4. Look up group record for isGroup flag
    const group = await getGroup(payload.botId, payload.groupJid);

    // 4b. Build group chat context — prepend recent messages so agent sees the conversation
    const groupContext = await buildGroupChatContext(
      payload.botId, payload.groupJid, !!group?.isGroup, payload.messageId, logger,
    );
    const prompt = groupContext + payload.content;

    // 6. Build feishu config (if channel is feishu, includes credential ARN + tool config)
    const feishuConfig = await buildFeishuConfig(payload.botId, payload.channelType, logger);

    // Resolve provider credentials (Anthropic API key + base URL) if bot uses anthropic-api
    const providerCreds = await resolveProviderCredentials(bot, payload.userId, logger);

    // 6b. Build proxy rules — merge defaults with user config, auto-fill Anthropic key
    const proxyRules = await buildProxyRules(payload.userId, providerCreds.anthropicApiKey, providerCreds.anthropicBaseUrl);

    // 6c. Check for model/provider change → force new session if needed
    const effectiveProvider = providerCreds.modelProvider ?? bot.modelProvider;
    const effectiveModel = providerCreds.model || bot.model;
    const existingSession = await getSession(payload.botId, payload.groupJid);
    const forceNewSession = shouldResetSession(existingSession, effectiveModel, effectiveProvider);
    if (forceNewSession) {
      logger.info(
        {
          botId: payload.botId, groupJid: payload.groupJid,
          oldModel: existingSession?.lastModel, newModel: effectiveModel,
          oldProvider: existingSession?.lastModelProvider, newProvider: effectiveProvider,
        },
        'Model/provider change detected, forcing new session',
      );
    }

    // 7. Build invocation payload
    const invocationPayload: InvocationPayload = {
      botId: payload.botId,
      botName: bot.name,
      groupJid: payload.groupJid,
      userId: payload.userId,
      channelType: payload.channelType,
      prompt,
      systemPrompt: bot.systemPrompt,
      model: providerCreds.model || bot.model,
      sessionPath: `${payload.userId}/${payload.botId}/sessions/${payload.groupJid}/`,
      memoryPaths: {
        botClaude: `${payload.userId}/${payload.botId}/CLAUDE.md`,
        groupPrefix: `${payload.userId}/${payload.botId}/workspace/${payload.groupJid}/`,
        learnings: `${payload.userId}/${payload.botId}/learnings/`,
      },
      isGroupChat: group?.isGroup,
      ...(payload.attachments && payload.attachments.length > 0 && {
        attachments: payload.attachments,
      }),
      ...(feishuConfig && { feishu: feishuConfig }),
      ...providerCreds,
      ...(forceNewSession && { forceNewSession: true }),
      ...(proxyRules.length > 0 && { proxyRules }),
      ...(bot.toolWhitelist && { toolWhitelist: bot.toolWhitelist }),
    };

    const skillPrefixes = await resolveSkillPrefixes(bot);
    if (skillPrefixes.length > 0) invocationPayload.skills = skillPrefixes;

    logger.info(
      { botId: payload.botId, groupJid: payload.groupJid, proxyRuleCount: proxyRules.length },
      'Invoking agent',
    );

    // 8. Invoke AgentCore
    const result = await invokeAgent(invocationPayload, logger);

    // 9. Store bot reply in DynamoDB
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

      // Notify the user about the error so they're not left waiting.
      // TODO: Sanitize before production — raw error may contain ARNs, bucket names, userId.
      // Currently acceptable for dev (no external access), but must be replaced with a
      // generic message before public deployment.
      const errorText = `Sorry, something went wrong while processing your message.\n\nError: ${result.error || 'Unknown error'}`;
      await sendChannelReply(
        payload.botId,
        payload.groupJid,
        payload.channelType,
        errorText,
        logger,
        payload.replyContext,
      );
    }

    // 10. Update session (always record model/provider for change detection)
    if (result.newSessionId) {
      await putSession({
        botId: payload.botId,
        groupJid: payload.groupJid,
        agentcoreSessionId: result.newSessionId,
        s3SessionPath: invocationPayload.sessionPath,
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        lastModel: effectiveModel,
        lastModelProvider: effectiveProvider,
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

  // Build feishu config for scheduled tasks too
  const feishuConfig = await buildFeishuConfig(payload.botId, channelType, logger);

  const providerCreds = await resolveProviderCredentials(bot, payload.userId, logger);
  const proxyRulesTask = await buildProxyRules(payload.userId, providerCreds.anthropicApiKey, providerCreds.anthropicBaseUrl);

  // Check for model/provider change
  const effectiveProvider = providerCreds.modelProvider ?? bot.modelProvider;
  const effectiveModel = providerCreds.model || bot.model;
  const existingSession = await getSession(payload.botId, payload.groupJid);
  const forceNewSession = shouldResetSession(existingSession, effectiveModel, effectiveProvider);
  if (forceNewSession) {
    logger.info(
      { botId: payload.botId, groupJid: payload.groupJid },
      'Model/provider change detected for scheduled task, forcing new session',
    );
  }

  const invocationPayload: InvocationPayload = {
    botId: payload.botId,
    botName: bot.name,
    groupJid: payload.groupJid,
    userId: payload.userId,
    channelType,
    prompt: task.prompt,
    systemPrompt: bot.systemPrompt,
    model: providerCreds.model || bot.model,
    isScheduledTask: true,
    sessionPath: `${payload.userId}/${payload.botId}/sessions/${payload.groupJid}/`,
    memoryPaths: {
      botClaude: `${payload.userId}/${payload.botId}/CLAUDE.md`,
      groupPrefix: `${payload.userId}/${payload.botId}/workspace/${payload.groupJid}/`,
      learnings: `${payload.userId}/${payload.botId}/learnings/`,
    },
    isGroupChat: group?.isGroup,
    ...(feishuConfig && { feishu: feishuConfig }),
    ...providerCreds,
    ...(forceNewSession && { forceNewSession: true }),
    ...(proxyRulesTask.length > 0 && {
      proxyRules: proxyRulesTask,
    }),
    ...(bot.toolWhitelist && { toolWhitelist: bot.toolWhitelist }),
  };

  const taskSkillPrefixes = await resolveSkillPrefixes(bot);
  if (taskSkillPrefixes.length > 0) invocationPayload.skills = taskSkillPrefixes;

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

  // Update session with model/provider for change detection
  if (result.newSessionId) {
    await putSession({
      botId: payload.botId,
      groupJid: payload.groupJid,
      agentcoreSessionId: result.newSessionId,
      s3SessionPath: invocationPayload.sessionPath,
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      lastModel: effectiveModel,
      lastModelProvider: effectiveProvider,
    });
  }
}

// ── Skill Resolution ─────────────────────────────────────────────────────────

/** Resolve bot skill IDs to flat S3 prefix names for runtime download. */
async function resolveSkillPrefixes(bot: Bot): Promise<string[]> {
  if (!bot.skills?.length) return [];
  const resolved = await Promise.all(bot.skills.map((id) => getSkill(id)));
  // Flatten: each skill record can have multiple s3Prefixes (e.g., plugin with 2 skills)
  return resolved
    .filter((s) => s?.status === 'active')
    .flatMap((s) => s!.s3Prefixes);
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
