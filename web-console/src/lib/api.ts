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
  model?: string;
  createdAt: string;
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
  model?: string;
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

// Bot API
export const bots = {
  list: () => request<Bot[]>('/bots'),
  get: (botId: string) => request<Bot>(`/bots/${botId}`),
  create: (data: CreateBotRequest) => request<Bot>('/bots', { method: 'POST', body: JSON.stringify(data) }),
  update: (botId: string, data: Partial<Bot>) => request<Bot>(`/bots/${botId}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (botId: string) => request<void>(`/bots/${botId}`, { method: 'DELETE' }),
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
  messages: (botId: string, groupJid: string, limit?: number) => request<Message[]>(`/bots/${botId}/groups/${groupJid}/messages${limit ? `?limit=${limit}` : ''}`),
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

// Admin API types
export interface AdminUser {
  userId: string;
  email: string;
  displayName: string;
  plan: string;
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

// Admin API
export const admin = {
  listUsers: () => request<AdminUser[]>('/admin'),
  getUser: (userId: string) => request<AdminUser>(`/admin/${userId}`),
  updateQuota: (userId: string, quota: UpdateQuotaRequest) => request<{ ok: boolean }>(`/admin/${userId}/quota`, { method: 'PUT', body: JSON.stringify(quota) }),
  updatePlan: (userId: string, plan: string) => request<{ ok: boolean }>(`/admin/${userId}/plan`, { method: 'PUT', body: JSON.stringify({ plan }) }),
};

// Memory API (CLAUDE.md files)
export interface MemoryResponse {
  content: string;
}

export const memory = {
  getShared: () => request<MemoryResponse>('/shared-memory'),
  updateShared: (content: string) => request<MemoryResponse>('/shared-memory', { method: 'PUT', body: JSON.stringify({ content }) }),
  getBotGlobal: (botId: string) => request<MemoryResponse>(`/bots/${botId}/memory`),
  updateBotGlobal: (botId: string, content: string) => request<MemoryResponse>(`/bots/${botId}/memory`, { method: 'PUT', body: JSON.stringify({ content }) }),
  getGroup: (botId: string, gid: string) => request<MemoryResponse>(`/bots/${botId}/groups/${gid}/memory`),
  updateGroup: (botId: string, gid: string, content: string) => request<MemoryResponse>(`/bots/${botId}/groups/${gid}/memory`, { method: 'PUT', body: JSON.stringify({ content }) }),
};
