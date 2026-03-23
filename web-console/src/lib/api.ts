import { getAuthToken } from './auth';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getAuthToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  // Only set Content-Type for requests with a body
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
  // Handle 204 No Content (e.g. DELETE responses)
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json();
}

// Types (simplified from shared, for frontend use)
export interface Bot {
  botId: string;
  name: string;
  description?: string;
  status: string;
  triggerPattern: string;
  providerId?: string;
  modelId?: string;
  /** @deprecated */
  model?: string;
  /** @deprecated */
  modelProvider?: 'bedrock' | 'anthropic-api';
  toolWhitelist?: ToolWhitelistConfig;
  createdAt: string;
}

export interface ToolWhitelistConfig {
  enabled: boolean;
  allowedMcpTools: string[];
  allowedSkills: string[];
}

export interface AvailableTools {
  mcpTools: Array<{ name: string; description: string }>;
  skills: Array<{ name: string; description: string }>;
}

export interface ChannelConfig {
  botId: string;
  channelType: string;
  channelId: string;
  status: string;
  healthStatus: string;
  webhookUrl: string;
  createdAt: string;
}

export interface Group {
  botId: string;
  groupJid: string;
  name: string;
  channelType: string;
  isGroup: boolean;
  lastMessageAt: string;
}

export interface Message {
  messageId: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  isBotMessage: boolean;
}

export interface ScheduledTask {
  taskId: string;
  groupJid: string;
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
  status: string;
  nextRun?: string;
  lastRun?: string;
}

export interface CreateBotRequest {
  name: string;
  description?: string;
  triggerPattern?: string;
  providerId?: string;
  modelId?: string;
}

export interface CreateChannelRequest {
  channelType: string;
  credentials: Record<string, string>;
}

export interface CreateTaskRequest {
  groupJid: string;
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
}

export interface UpdateTaskRequest {
  status?: string;
  prompt?: string;
}

// Provider types (admin-managed)
export interface ProviderPublic {
  providerId: string;
  providerName: string;
  providerType: 'bedrock' | 'anthropic-compatible-api';
  modelIds: string[];
  isDefault: boolean;
}

export interface ProviderFull extends ProviderPublic {
  baseUrl?: string;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProviderRequest {
  providerName: string;
  providerType: 'bedrock' | 'anthropic-compatible-api';
  baseUrl?: string;
  apiKey?: string;
  modelIds: string[];
  isDefault?: boolean;
}

export interface UpdateProviderRequest {
  providerName?: string;
  providerType?: 'bedrock' | 'anthropic-compatible-api';
  baseUrl?: string | null;
  apiKey?: string;
  modelIds?: string[];
  isDefault?: boolean;
}

// Bot API
export const bots = {
  list: () => request<Bot[]>('/bots'),
  get: (botId: string) => request<Bot>(`/bots/${botId}`),
  create: (data: CreateBotRequest) => request<Bot>('/bots', { method: 'POST', body: JSON.stringify(data) }),
  update: (botId: string, data: Partial<Bot>) => request<Bot>(`/bots/${botId}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (botId: string) => request<void>(`/bots/${botId}`, { method: 'DELETE' }),
  availableTools: () => request<AvailableTools>('/bots/available-tools'),
};

// Channel API
export const channels = {
  list: (botId: string) => request<ChannelConfig[]>(`/bots/${botId}/channels`),
  create: (botId: string, data: CreateChannelRequest) => request<ChannelConfig>(`/bots/${botId}/channels`, { method: 'POST', body: JSON.stringify(data) }),
  delete: (botId: string, channelType: string) => request<void>(`/bots/${botId}/channels/${channelType}`, { method: 'DELETE' }),
};

// Group API
export const groups = {
  list: (botId: string) => request<Group[]>(`/bots/${botId}/groups`),
  messages: (botId: string, groupJid: string, limit?: number) => request<Message[]>(`/bots/${botId}/groups/${encodeURIComponent(groupJid)}/messages${limit ? `?limit=${limit}` : ''}`),
};

// Task API
export const tasks = {
  list: (botId: string) => request<ScheduledTask[]>(`/bots/${botId}/tasks`),
  create: (botId: string, data: CreateTaskRequest) => request<ScheduledTask>(`/bots/${botId}/tasks`, { method: 'POST', body: JSON.stringify(data) }),
  update: (botId: string, taskId: string, data: UpdateTaskRequest) => request<ScheduledTask>(`/bots/${botId}/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (botId: string, taskId: string) => request<void>(`/bots/${botId}/tasks/${taskId}`, { method: 'DELETE' }),
};

// User API
export const user = {
  me: () => request<{ userId: string; email: string; plan?: string; quota?: any; usage?: { month: string; tokens: number; invocations: number }; isAdmin?: boolean }>('/me'),
};

// Providers API (public — returns only non-sensitive fields)
export const providers = {
  list: () => request<ProviderPublic[]>('/providers'),
};

// Admin API types
export interface AdminUser {
  userId: string;
  email: string;
  displayName: string;
  plan: string;
  status?: string;
  quota: {
    maxBots: number;
    maxGroupsPerBot: number;
    maxTasksPerBot: number;
    maxConcurrentAgents: number;
    maxMonthlyTokens: number;
  };
  usageMonth: string;
  usageTokens: number;
  usageInvocations: number;
  botCount: number;
  createdAt: string;
  lastLogin: string;
}

export interface UpdateQuotaRequest {
  maxBots?: number;
  maxGroupsPerBot?: number;
  maxTasksPerBot?: number;
  maxConcurrentAgents?: number;
  maxMonthlyTokens?: number;
}

export interface PlanQuotaValues {
  maxBots: number;
  maxGroupsPerBot: number;
  maxTasksPerBot: number;
  maxConcurrentAgents: number;
  maxMonthlyTokens: number;
}

export type PlanQuotasConfig = Record<'free' | 'pro' | 'enterprise', PlanQuotaValues>;

// Admin API
export const admin = {
  listUsers: () => request<AdminUser[]>('/admin'),
  getUser: (userId: string) => request<AdminUser>(`/admin/${userId}`),
  updateQuota: (userId: string, quota: UpdateQuotaRequest) => request<{ ok: boolean }>(`/admin/${userId}/quota`, { method: 'PUT', body: JSON.stringify(quota) }),
  updatePlan: (userId: string, plan: string) => request<{ ok: boolean }>(`/admin/${userId}/plan`, { method: 'PUT', body: JSON.stringify({ plan }) }),
  getPlans: () => request<PlanQuotasConfig>('/admin/plans'),
  updatePlans: (quotas: PlanQuotasConfig) => request<{ ok: boolean }>('/admin/plans', { method: 'PUT', body: JSON.stringify(quotas) }),
  createUser: (email: string, plan?: string) =>
    request<{ ok: boolean; userId: string; email: string }>('/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email, plan: plan || 'free' }),
    }),
  updateUserStatus: (userId: string, status: string) =>
    request<{ ok: boolean }>(`/admin/${userId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    }),
  deleteUser: (userId: string) =>
    request<{ ok: boolean }>(`/admin/${userId}`, { method: 'DELETE' }),
  listProviders: () => request<ProviderFull[]>('/admin/providers'),
  createProvider: (data: CreateProviderRequest) =>
    request<ProviderFull>('/admin/providers', { method: 'POST', body: JSON.stringify(data) }),
  updateProvider: (providerId: string, data: UpdateProviderRequest) =>
    request<ProviderFull>(`/admin/providers/${providerId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProvider: (providerId: string) =>
    request<void>(`/admin/providers/${providerId}`, { method: 'DELETE' }),
};

// File Browser types
export interface FileEntry {
  key: string;
  name: string;
  isFolder: boolean;
  size?: number;
  lastModified?: string;
}

export interface FileContent {
  content: string;
  size: number;
  lastModified?: string;
  contentType?: string;
}

// Memory API (CLAUDE.md files)
export interface MemoryResponse {
  content: string;
}

// File Browser API
export const files = {
  list: (botId: string, prefix?: string) =>
    request<{ entries: FileEntry[] }>(`/bots/${botId}/files${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''}`),
  content: (botId: string, key: string) =>
    request<FileContent>(`/bots/${botId}/files/content?key=${encodeURIComponent(key)}`),
};

// Proxy Rules API (credential injection)
export interface ProxyRuleSummary {
  id: string;
  name: string;
  prefix: string;
  target: string;
  authType: 'bearer' | 'api-key' | 'basic';
  headerName?: string;
  hasValue: boolean;
}

export interface ProxyRuleInput {
  name: string;
  prefix: string;
  target: string;
  authType: 'bearer' | 'api-key' | 'basic';
  headerName?: string;
  value: string;
}

export const proxyRules = {
  list: () => request<ProxyRuleSummary[]>('/proxy-rules'),
  create: (rule: ProxyRuleInput) => request<ProxyRuleSummary>('/proxy-rules', { method: 'POST', body: JSON.stringify(rule) }),
  update: (id: string, rule: Partial<ProxyRuleInput>) => request<ProxyRuleSummary>(`/proxy-rules/${id}`, { method: 'PUT', body: JSON.stringify(rule) }),
  remove: (id: string) => request<{ ok: boolean }>(`/proxy-rules/${id}`, { method: 'DELETE' }),
};

export const memory = {
  getShared: () => request<MemoryResponse>('/shared-memory'),
  updateShared: (content: string) => request<MemoryResponse>('/shared-memory', { method: 'PUT', body: JSON.stringify({ content }) }),
  getBotGlobal: (botId: string) => request<MemoryResponse>(`/bots/${botId}/memory`),
  updateBotGlobal: (botId: string, content: string) => request<MemoryResponse>(`/bots/${botId}/memory`, { method: 'PUT', body: JSON.stringify({ content }) }),
  getGroup: (botId: string, gid: string) => request<MemoryResponse>(`/bots/${botId}/groups/${encodeURIComponent(gid)}/memory`),
  updateGroup: (botId: string, gid: string, content: string) => request<MemoryResponse>(`/bots/${botId}/groups/${encodeURIComponent(gid)}/memory`, { method: 'PUT', body: JSON.stringify({ content }) }),
};
