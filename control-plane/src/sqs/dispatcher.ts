// ClawBot Cloud — Message Dispatcher
// Core message processing: the cloud equivalent of NanoClaw's message loop
// Receives SQS messages, loads context, invokes agent, stores reply, sends to channel

import type { Message as SQSMessage } from '@aws-sdk/client-sqs';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type {
  ChannelType,
  FeishuInvocationConfig,
  InvocationPayload,
  InvocationResult,
  McpEnvVar,
  ResolvedMcpConfig,
  SqsInboundPayload,
  SqsPayload,
  SqsTaskPayload,
} from '@clawbot/shared';
import type { ModelProvider, ProviderType, Session } from '@clawbot/shared';
import { config } from '../config.js';
import {
  getGroup,
  ensureUser,
  getSession,
  touchSessionTask,
  clearSessionTask,
  setSessionResetPending,
  getTask,
  getRecentMessages,
  checkAndAcquireAgentSlot,
  releaseAgentSlot,
  getChannelsByBot,
  getProvider,
  getSkill,
  listBotMcpConfigs,
  getMcpServer,
} from '../services/dynamo.js';
import {
  parseSlashCommand,
  replyUnknown,
  REPLY_RESET,
  REPLY_HELP,
} from './slash-commands.js';
import { getProviderApiKey, getProxyRules } from '../services/secrets.js';
import { getCachedBot } from '../services/cached-lookups.js';
import type { Bot } from '@clawbot/shared';
import { getRegistry } from '../adapters/registry.js';
import type { ReplyContext, ReplyOptions } from '@clawbot/shared/channel-adapter';
import type { Logger } from 'pino';
import { assignTaskForSession, isTaskRunning } from './task-manager.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Detect conditions that require session reset (force SDK continue:false) */
export function shouldResetSession(
  session: Session | null,
  currentModel: string | undefined,
  currentProvider: ModelProvider | undefined,
): boolean {
  if (!session) return false;
  // User asked to reset via /clear /reset /new slash command
  if (session.resetPending) return true;
  if (!session.lastModel && !session.lastModelProvider) return false;
  return session.lastModel !== currentModel || session.lastModelProvider !== currentProvider;
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

  // 1b. Slash-command interception — Control Plane handles /clear /reset /new /help
  //     and unknown /foo locally (no quota, no agent). /context /compact fall through
  //     but skip group-context prepend and carry an sdkCommand hint for the runtime's
  //     empty-result fallback.
  const parsed = parseSlashCommand(payload.content);
  if (parsed.kind === 'dispatcher') {
    if (parsed.command === 'help') {
      logger.info({ botId: payload.botId, groupJid: payload.groupJid, command: parsed.command }, 'Slash command handled');
      await sendChannelReply(
        payload.botId, payload.groupJid, payload.channelType,
        REPLY_HELP, logger, payload.replyContext,
      );
      return;
    }
    // clear / reset / new — mark session for reset on the next real message
    await setSessionResetPending(payload.botId, payload.groupJid, true);
    logger.info({ botId: payload.botId, groupJid: payload.groupJid, command: parsed.command }, 'Slash command handled (session reset queued)');
    await sendChannelReply(
      payload.botId, payload.groupJid, payload.channelType,
      REPLY_RESET, logger, payload.replyContext,
    );
    return;
  }
  if (parsed.kind === 'unknown') {
    logger.info({ botId: payload.botId, groupJid: payload.groupJid, command: parsed.command }, 'Unknown slash command');
    await sendChannelReply(
      payload.botId, payload.groupJid, payload.channelType,
      replyUnknown(parsed.command), logger, payload.replyContext,
    );
    return;
  }
  // parsed.kind === 'sdk' | 'none' fall through to the normal agent flow below.

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

    // 4b. Build group chat context — prepend recent messages so agent sees the conversation.
    //     Skip for SDK slash commands (/context, /compact) where group context is noise.
    const isSdkCommand = parsed.kind === 'sdk';
    const groupContext = isSdkCommand
      ? ''
      : await buildGroupChatContext(
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
      ...(isSdkCommand && { sdkCommand: parsed.command }),
      ...(proxyRules.length > 0 && { proxyRules }),
      ...(bot.toolWhitelist && { toolWhitelist: bot.toolWhitelist }),
      ...(payload.replyContext && { replyContext: payload.replyContext }),
    };

    const skillPrefixes = await resolveSkillPrefixes(bot);
    if (skillPrefixes.length > 0) invocationPayload.skills = skillPrefixes;

    const mcpConfigs = await resolveMcpConfigs(bot);
    if (mcpConfigs.length > 0) invocationPayload.mcpConfigs = mcpConfigs;

    logger.info(
      { botId: payload.botId, groupJid: payload.groupJid, proxyRuleCount: proxyRules.length },
      'Invoking agent',
    );

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

  const taskMcpConfigs = await resolveMcpConfigs(bot);
  if (taskMcpConfigs.length > 0) invocationPayload.mcpConfigs = taskMcpConfigs;

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

// ── MCP Config Resolution ───────────────────────────────────────────────────

const secretsManager = new SecretsManagerClient({ region: config.region });

async function resolveMcpConfigs(bot: Bot): Promise<ResolvedMcpConfig[]> {
  if (!bot.mcpServers?.length) return [];

  const botMcpConfigs = await listBotMcpConfigs(bot.botId);
  const enabledConfigs = botMcpConfigs.filter((c) => c.enabled);
  if (enabledConfigs.length === 0) return [];

  const resolved: ResolvedMcpConfig[] = [];

  for (const cfg of enabledConfigs) {
    let serverDef: {
      name: string; type: 'stdio' | 'sse' | 'http';
      command?: string; args?: string[]; npmPackages?: string[];
      url?: string; headers?: Record<string, string>;
      envVars?: McpEnvVar[];
    };

    if (cfg.source === 'platform') {
      const platformServer = await getMcpServer(cfg.mcpServerId);
      if (!platformServer || platformServer.status !== 'active') continue;
      serverDef = platformServer;
    } else {
      if (!cfg.customConfig) continue;
      serverDef = cfg.customConfig;
    }

    // Resolve env var templates: secretRefs → Secrets Manager values
    const resolvedEnvVars: Record<string, string> = {};
    if (serverDef.envVars) {
      for (const ev of serverDef.envVars) {
        const secretRef = cfg.secretRefs?.[ev.name];
        if (secretRef) {
          try {
            const secret = await secretsManager.send(
              new GetSecretValueCommand({ SecretId: secretRef }),
            );
            resolvedEnvVars[ev.name] = secret.SecretString || '';
          } catch {
            // Skip if secret not found — env var will be empty
          }
        } else if (ev.template && !ev.template.startsWith('${secret:')) {
          resolvedEnvVars[ev.name] = ev.template;
        }
      }
    }

    resolved.push({
      mcpServerId: cfg.mcpServerId,
      name: serverDef.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_'),
      type: serverDef.type,
      ...(serverDef.command && { command: serverDef.command }),
      ...(serverDef.args && { args: serverDef.args }),
      ...(serverDef.npmPackages && { npmPackages: serverDef.npmPackages }),
      ...(serverDef.url && { url: serverDef.url }),
      ...(serverDef.headers && { headers: serverDef.headers }),
      ...(Object.keys(resolvedEnvVars).length > 0 && { envVars: resolvedEnvVars }),
    });
  }

  return resolved;
}

// ── Agent Invocation ──────────────────────────────────────────────────────

interface AgentInvoker {
  invoke(payload: InvocationPayload, logger: Logger): Promise<InvocationResult>;
}

class AgentCoreInvoker implements AgentInvoker {
  private client = new BedrockAgentCoreClient({ region: config.region });

  async invoke(payload: InvocationPayload, logger: Logger): Promise<InvocationResult> {
    const runtimeArn = config.agentcore.runtimeArn;
    if (!runtimeArn) {
      logger.error('AgentCore runtime ARN is not configured (AGENTCORE_RUNTIME_ARN)');
      return { status: 'error', result: null, error: 'AgentCore runtime ARN is not configured' };
    }

    logger.info(
      { botId: payload.botId, groupJid: payload.groupJid, promptLength: payload.prompt.length, isScheduledTask: payload.isScheduledTask },
      'Invoking AgentCore runtime',
    );

    try {
      const response = await this.client.send(
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
      return body.output ?? body;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'AgentCore runtime invocation failed');
      return { status: 'error', result: null, error: `AgentCore invocation failed: ${message}` };
    }
  }
}

class EcsTaskInvoker implements AgentInvoker {
  private static readonly NETWORK_MAX_RETRIES = 3;
  private static readonly NETWORK_RETRY_DELAY_MS = 5_000;

  async invoke(payload: InvocationPayload, logger: Logger): Promise<InvocationResult> {
    // 1. Look up existing task for this session
    const session = await getSession(payload.botId, payload.groupJid);

    if (session?.taskStatus === 'running' && session.taskIp) {
      // 2a. Try dispatch to existing task
      const result = await this.httpInvoke(session.taskIp, payload, logger);
      if (result) {
        await touchSessionTask(payload.botId, payload.groupJid);
        return result;
      }
      // Task gone — clear stale record and reassign
      logger.warn({ taskArn: session.taskArn, botId: payload.botId }, 'Task unreachable, reassigning');
      await clearSessionTask(payload.botId, payload.groupJid);
    }

    // 2b. Assign a new task (warm pool or cold start) — retry up to 3 times
    // if the assigned task is unreachable (race between idle shutdown and claim).
    // 3 attempts covers the entire warm pool (default 2) + one cold start fallback.
    for (let assignAttempt = 0; assignAttempt < 3; assignAttempt++) {
      const taskIp = await assignTaskForSession(payload.botId, payload.groupJid, logger);

      // 3. Dispatch to newly assigned task
      const result = await this.httpInvoke(taskIp, payload, logger);
      if (result) {
        await touchSessionTask(payload.botId, payload.groupJid);
        return result;
      }

      // Task unreachable (e.g. idle shutdown race) — clear and retry
      if (assignAttempt < 2) {
        logger.warn({ botId: payload.botId, taskIp, attempt: assignAttempt + 1 }, 'Newly assigned task unreachable, clearing and retrying');
        await clearSessionTask(payload.botId, payload.groupJid);
      }
    }
    return { status: 'error', result: null, error: 'Failed to dispatch to newly assigned task' };
  }

  /** HTTP POST to task. Returns null if task is unreachable (for reassignment). */
  private async httpInvoke(
    taskIp: string,
    payload: InvocationPayload,
    logger: Logger,
  ): Promise<InvocationResult | null> {
    const url = `http://${taskIp}:8080/invocations`;

    for (let attempt = 0; attempt < EcsTaskInvoker.NETWORK_MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
          const text = await res.text();
          logger.error({ status: res.status, body: text }, 'Agent task returned error');
          return { status: 'error', result: null, error: `Agent task returned ${res.status}: ${text}` };
        }

        return { status: 'accepted', result: null };
      } catch (err: unknown) {
        if (attempt < EcsTaskInvoker.NETWORK_MAX_RETRIES - 1) {
          logger.warn({ err, attempt: attempt + 1, taskIp }, 'Agent task network error, retrying');
          await new Promise((r) => setTimeout(r, EcsTaskInvoker.NETWORK_RETRY_DELAY_MS));
          continue;
        }
        logger.error({ err, taskIp }, 'Agent task unreachable after retries');
        return null; // Signal to caller: task is gone, reassign
      }
    }
    return null;
  }
}

function createInvoker(): AgentInvoker {
  if (config.agentMode === 'ecs') return new EcsTaskInvoker();
  return new AgentCoreInvoker();
}

const agentInvoker = createInvoker();

export async function invokeAgent(
  payload: InvocationPayload,
  logger: Logger,
): Promise<InvocationResult> {
  return agentInvoker.invoke(payload, logger);
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
    // TODO: Track delivery failure in DynamoDB (markReplyFailed) for Web Console visibility
  }
}
