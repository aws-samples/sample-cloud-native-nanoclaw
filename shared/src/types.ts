// ============================================================
// ClawBot Cloud — Shared Type Definitions
// Evolved from NanoClaw's src/types.ts for multi-tenant cloud
// ============================================================

// --- User (DynamoDB: users table, PK=userId) ---

export interface UserQuota {
  maxBots: number;
  maxGroupsPerBot: number;
  maxTasksPerBot: number;
  maxConcurrentAgents: number;
  maxMonthlyTokens: number;
}

export type PlanName = 'free' | 'pro' | 'enterprise';

export type PlanQuotas = Record<PlanName, UserQuota>;

export const PLAN_QUOTAS: PlanQuotas = {
  free: {
    maxBots: 2,
    maxGroupsPerBot: 5,
    maxTasksPerBot: 10,
    maxConcurrentAgents: 1,
    maxMonthlyTokens: 10_000_000,
  },
  pro: {
    maxBots: 10,
    maxGroupsPerBot: 20,
    maxTasksPerBot: 50,
    maxConcurrentAgents: 5,
    maxMonthlyTokens: 100_000_000,
  },
  enterprise: {
    maxBots: 50,
    maxGroupsPerBot: 100,
    maxTasksPerBot: 200,
    maxConcurrentAgents: 20,
    maxMonthlyTokens: 1_000_000_000,
  },
};

export type UserStatus = 'active' | 'suspended' | 'deleted';

export const DEFAULT_QUOTA: UserQuota = PLAN_QUOTAS.free;

export interface User {
  userId: string; // Cognito sub
  email: string;
  displayName: string;
  plan: PlanName;
  status: UserStatus;
  quota: UserQuota;
  usageMonth: string; // YYYY-MM
  usageTokens: number;
  usageInvocations: number;
  activeAgents: number;
  createdAt: string;
  lastLogin: string;
}

// --- Model Provider ---

export type ProviderType = 'bedrock' | 'anthropic-compatible-api';

export interface Provider {
  providerId: string;
  providerName: string;
  providerType: ProviderType;
  baseUrl?: string;
  hasApiKey: boolean;
  modelIds: string[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** @deprecated Use ProviderType instead — kept for Session.lastModelProvider backward compat */
export type ModelProvider = 'bedrock' | 'anthropic-api';

// --- Bot (DynamoDB: bots table, PK=userId, SK=botId) ---
// Evolved from NanoClaw's RegisteredGroup

export interface Bot {
  userId: string;
  botId: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  triggerPattern: string; // e.g. "@BotName"
  providerId?: string;   // References providers table
  modelId?: string;      // One of provider's modelIds
  /** @deprecated Use providerId/modelId */
  model?: string;
  /** @deprecated Use providerId/modelId */
  modelProvider?: ModelProvider;
  status: 'created' | 'active' | 'paused' | 'deleted';
  containerConfig?: BotContainerConfig;
  toolWhitelist?: ToolWhitelistConfig;
  createdAt: string;
  updatedAt: string;
}

export interface BotContainerConfig {
  maxTurns?: number;
  timeout?: number;
}

export interface ToolWhitelistConfig {
  mcpToolsEnabled: boolean;
  skillsEnabled: boolean;
  allowedMcpTools: string[];
  allowedSkills: string[];
}

// --- Channel (DynamoDB: channels table, PK=botId, SK=channelType#channelId) ---
// Evolved from NanoClaw's Channel interface — now BYOK credentials

export type ChannelType = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'feishu' | 'dingtalk';

export interface ChannelConfig {
  botId: string;
  channelType: ChannelType;
  channelId: string;
  credentialSecretArn: string;
  webhookUrl: string;
  status: 'connected' | 'disconnected' | 'error' | 'pending_webhook';
  healthStatus: 'healthy' | 'unhealthy' | 'unknown';
  consecutiveFailures: number;
  lastHealthCheck?: string; // ISO timestamp of last health check
  config?: Record<string, unknown>;
  createdAt: string;
}

// --- Group (DynamoDB: groups table, PK=botId, SK=groupJid) ---
// Evolved from NanoClaw's RegisteredGroup

export interface Group {
  botId: string;
  groupJid: string;
  name: string;
  channelType: ChannelType;
  isGroup: boolean;
  requiresTrigger: boolean;
  lastMessageAt: string;
  agentcoreSessionId?: string;
  sessionStatus: 'active' | 'idle' | 'terminated';
}

// --- Message (DynamoDB: messages table, PK=botId#groupJid, SK=timestamp) ---
// Evolved from NanoClaw's NewMessage

export interface Message {
  botId: string;
  groupJid: string;
  timestamp: string;
  messageId: string;
  sender: string;
  senderName: string;
  content: string;
  isFromMe: boolean;
  isBotMessage: boolean;
  channelType: ChannelType;
  ttl: number; // DynamoDB TTL (epoch seconds, 90 days from creation)
  attachments?: Attachment[];
}

export interface Attachment {
  type: 'image' | 'audio' | 'document' | 'video';
  s3Key: string;
  mimeType: string;
  fileName?: string;
  size?: number;
}

// --- Scheduled Task (DynamoDB: tasks table, PK=botId, SK=taskId) ---
// Evolved from NanoClaw's ScheduledTask

export interface ScheduledTask {
  botId: string;
  taskId: string;
  groupJid: string;
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  contextMode: 'group' | 'isolated';
  status: 'active' | 'paused' | 'completed';
  nextRun?: string;
  lastRun?: string;
  lastResult?: string;
  eventbridgeScheduleArn?: string;
  createdAt: string;
}

// --- Session (DynamoDB: sessions table, PK=botId#groupJid, SK="current") ---

export interface Session {
  botId: string;
  groupJid: string;
  agentcoreSessionId: string;
  s3SessionPath: string;
  lastActiveAt: string;
  status: 'active' | 'idle' | 'terminated';
  /** Model used in the last invocation (for change detection) */
  lastModel?: string;
  /** Model provider used in the last invocation */
  lastModelProvider?: ModelProvider;
}

// --- SQS Message Payloads ---

export interface SqsReplyContext {
  discordInteractionToken?: string;
  discordChannelId?: string;
  slackResponseUrl?: string;
  feishuChatId?: string;
  feishuMessageId?: string;
  dingtalkConversationId?: string;
  dingtalkMsgId?: string;
  dingtalkSessionWebhook?: string;
  dingtalkIsGroup?: boolean;
  dingtalkSenderStaffId?: string;
}

export interface SqsInboundPayload {
  type: 'inbound_message';
  botId: string;
  groupJid: string;
  userId: string;
  messageId: string;
  content: string;
  channelType: ChannelType;
  timestamp: string;
  attachments?: Attachment[];
  replyContext?: SqsReplyContext;
}

export interface SqsTaskPayload {
  type: 'scheduled_task';
  botId: string;
  groupJid: string;
  userId: string;
  taskId: string;
  timestamp: string;
}

export type SqsPayload = SqsInboundPayload | SqsTaskPayload;

// --- Agent Invocation (AgentCore /invocations) ---
// Evolved from NanoClaw's ContainerInput

export interface InvocationPayload {
  botId: string;
  botName: string;
  groupJid: string;
  userId: string;
  channelType: ChannelType;
  prompt: string;
  systemPrompt?: string;
  model?: string; // e.g. "global.anthropic.claude-sonnet-4-6"
  modelProvider?: ModelProvider;
  providerType?: ProviderType;
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  sessionPath: string; // S3 path: {userId}/{botId}/sessions/{groupJid}/
  memoryPaths: MemoryPaths;
  attachments?: Attachment[];
  isScheduledTask?: boolean;
  isGroupChat?: boolean;
  maxTurns?: number;
  /** Feishu/Lark credentials + tool config (present when channelType is 'feishu') */
  feishu?: FeishuInvocationConfig;
  /** When true, agent runtime should NOT resume existing session (model/provider changed) */
  forceNewSession?: boolean;
  /** Credential proxy rules — injected by control-plane from user config */
  proxyRules?: InvocationProxyRule[];
  /** Per-bot tool/skill whitelist config */
  toolWhitelist?: ToolWhitelistConfig;
}

/** Proxy rule passed through invocation payload (secrets included). */
export interface InvocationProxyRule {
  prefix: string;
  target: string;
  authType: 'bearer' | 'api-key' | 'basic';
  headerName?: string;
  value: string;
}

/** Feishu/Lark config passed to agent runtime for MCP tool registration. */
export interface FeishuInvocationConfig {
  /** Secrets Manager ARN holding the Lark app credentials */
  credentialSecretArn: string;
  /** Lark API domain: 'feishu' (default) or 'lark' */
  domain?: string;
  /** Which tool categories to enable */
  tools: {
    doc: boolean;
    wiki: boolean;
    drive: boolean;
    perm: boolean;
  };
}

export interface MemoryPaths {
  /** S3 key for bot-level CLAUDE.md → /home/node/.claude/CLAUDE.md */
  botClaude: string;
  /** S3 prefix for group workspace → /workspace/group/ (full directory sync) */
  groupPrefix: string;
  /** S3 prefix for learnings directory → /workspace/learnings/ */
  learnings?: string;
}

// Evolved from NanoClaw's ContainerOutput (stdout markers)
export interface InvocationResult {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  tokensUsed?: number;
  error?: string;
}

// --- SQS Reply Payload (agent → control plane) ---

export interface SqsTextReplyPayload {
  type: 'reply';
  botId: string;
  groupJid: string;
  channelType: ChannelType;
  text: string;
  timestamp: string;
}

export interface SqsFileReplyPayload {
  type: 'file_reply';
  botId: string;
  groupJid: string;
  channelType: ChannelType;
  s3Key: string;
  fileName: string;
  mimeType: string;
  size: number;
  caption?: string;
  timestamp: string;
}

export type SqsReplyPayload = SqsTextReplyPayload | SqsFileReplyPayload;

// --- API Request/Response Types ---

export interface CreateBotRequest {
  name: string;
  description?: string;
  systemPrompt?: string;
  triggerPattern?: string;
  providerId?: string;
  modelId?: string;
}

export interface CreateChannelRequest {
  channelType: ChannelType;
  credentials: Record<string, string>; // e.g. { botToken: "..." } for Telegram
}

export interface CreateTaskRequest {
  groupJid: string;
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  contextMode?: 'group' | 'isolated';
}

export interface UpdateBotRequest {
  name?: string;
  description?: string;
  systemPrompt?: string;
  triggerPattern?: string;
  providerId?: string;
  modelId?: string;
  status?: 'active' | 'paused' | 'deleted';
  toolWhitelist?: ToolWhitelistConfig;
}

export interface UpdateTaskRequest {
  status?: 'active' | 'paused';
  prompt?: string;
  scheduleValue?: string;
}
