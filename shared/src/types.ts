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

export interface User {
  userId: string; // Cognito sub
  email: string;
  displayName: string;
  plan: 'free' | 'pro' | 'enterprise';
  quota: UserQuota;
  usageMonth: string; // YYYY-MM
  usageTokens: number;
  usageInvocations: number;
  activeAgents: number;
  createdAt: string;
  lastLogin: string;
}

// --- Bot (DynamoDB: bots table, PK=userId, SK=botId) ---
// Evolved from NanoClaw's RegisteredGroup

export interface Bot {
  userId: string;
  botId: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  triggerPattern: string; // e.g. "@BotName"
  status: 'active' | 'paused' | 'deleted';
  containerConfig?: BotContainerConfig;
  createdAt: string;
  updatedAt: string;
}

export interface BotContainerConfig {
  maxTurns?: number;
  timeout?: number;
}

// --- Channel (DynamoDB: channels table, PK=botId, SK=channelType#channelId) ---
// Evolved from NanoClaw's Channel interface — now BYOK credentials

export type ChannelType = 'telegram' | 'discord' | 'slack' | 'whatsapp';

export interface ChannelConfig {
  botId: string;
  channelType: ChannelType;
  channelId: string;
  credentialSecretArn: string;
  webhookUrl: string;
  status: 'connected' | 'disconnected' | 'error';
  healthStatus: 'healthy' | 'unhealthy' | 'unknown';
  consecutiveFailures: number;
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
}

// --- SQS Message Payloads ---

export interface SqsInboundPayload {
  type: 'inbound_message';
  botId: string;
  groupJid: string;
  userId: string;
  messageId: string;
  channelType: ChannelType;
  timestamp: string;
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
  sessionPath: string; // S3 path: {userId}/{botId}/sessions/{groupJid}/
  memoryPaths: MemoryPaths;
  attachments?: Attachment[];
  isScheduledTask?: boolean;
  maxTurns?: number;
}

export interface MemoryPaths {
  shared: string; // {userId}/shared/CLAUDE.md (read-only)
  botGlobal: string; // {userId}/{botId}/memory/global/CLAUDE.md (read-only)
  group: string; // {userId}/{botId}/memory/{groupJid}/CLAUDE.md (read-write)
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

export interface SqsReplyPayload {
  type: 'reply';
  botId: string;
  groupJid: string;
  channelType: ChannelType;
  text: string;
  timestamp: string;
}

// --- API Request/Response Types ---

export interface CreateBotRequest {
  name: string;
  description?: string;
  systemPrompt?: string;
  triggerPattern?: string;
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
  status?: 'active' | 'paused';
}

export interface UpdateTaskRequest {
  status?: 'active' | 'paused';
  prompt?: string;
  scheduleValue?: string;
}
