// ClawBot Cloud — DynamoDB Service Layer
// Port of NanoClaw's src/db.ts for multi-tenant cloud (DynamoDB)

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { config } from '../config.js';
import type {
  Bot,
  ChannelConfig,
  Group,
  Message,
  PlanQuotas,
  Provider,
  ScheduledTask,
  Session,
  User,
  UserQuota,
  UserStatus,
} from '@clawbot/shared';
import { DEFAULT_QUOTA, PLAN_QUOTAS } from '@clawbot/shared';

const rawClient = new DynamoDBClient({ region: config.region });
const client = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true },
});

// TTL: 90 days from now in epoch seconds
function ttl90Days(): number {
  return Math.floor(Date.now() / 1000) + 90 * 24 * 3600;
}

// ── User operations ─────────────────────────────────────────────────────────

const userIdSchema = z.string().min(1, 'userId is required');

export async function getUser(userId: string): Promise<User | null> {
  userIdSchema.parse(userId);
  const result = await client.send(
    new GetCommand({
      TableName: config.tables.users,
      Key: { userId },
    }),
  );
  return (result.Item as User) ?? null;
}

export async function putUser(user: User): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: config.tables.users,
      Item: user,
    }),
  );
}

/** Get user, auto-provisioning with plan-based quota if record is missing or incomplete. */
export async function ensureUser(userId: string, email?: string): Promise<User> {
  const existing = await getUser(userId);
  if (existing?.quota) return existing;

  // Fetch admin-configured plan quotas; fall back to built-in defaults
  const planQuotas = await getPlanQuotas();
  const freeQuota = planQuotas.free ?? DEFAULT_QUOTA;

  const now = new Date().toISOString();
  const user: User = {
    userId,
    email: email || existing?.email || '',
    displayName: existing?.displayName || '',
    plan: existing?.plan || 'free',
    status: existing?.status || 'active',
    quota: existing?.quota || freeQuota,
    usageMonth: existing?.usageMonth || now.slice(0, 7),
    usageTokens: existing?.usageTokens || 0,
    usageInvocations: existing?.usageInvocations || 0,
    activeAgents: existing?.activeAgents || 0,
    createdAt: existing?.createdAt || now,
    lastLogin: now,
  };
  await putUser(user);
  return user;
}

export async function updateLastLogin(userId: string): Promise<void> {
  userIdSchema.parse(userId);
  await client.send(
    new UpdateCommand({
      TableName: config.tables.users,
      Key: { userId },
      UpdateExpression: 'SET lastLogin = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }),
  );
}

export async function updateUserUsage(
  userId: string,
  tokensUsed: number,
): Promise<void> {
  userIdSchema.parse(userId);
  const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  // Try normal update with month check — counters accumulate within the same month
  try {
    await client.send(
      new UpdateCommand({
        TableName: config.tables.users,
        Key: { userId },
        UpdateExpression:
          'SET usageTokens = if_not_exists(usageTokens, :zero) + :tokens, usageInvocations = if_not_exists(usageInvocations, :zero) + :one, usageMonth = :month',
        ConditionExpression:
          'attribute_not_exists(usageMonth) OR usageMonth = :month',
        ExpressionAttributeValues: {
          ':tokens': tokensUsed,
          ':one': 1,
          ':zero': 0,
          ':month': currentMonth,
        },
      }),
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === 'ConditionalCheckFailedException'
    ) {
      // Month changed — reset counters to this invocation's values
      await client.send(
        new UpdateCommand({
          TableName: config.tables.users,
          Key: { userId },
          UpdateExpression:
            'SET usageTokens = :tokens, usageInvocations = :one, usageMonth = :month',
          ExpressionAttributeValues: {
            ':tokens': tokensUsed,
            ':one': 1,
            ':month': currentMonth,
          },
        }),
      );
    } else {
      throw err;
    }
  }
}

const SLOT_TTL_MS = 5 * 60 * 1000; // 5 minutes — auto-release stale slots

export async function checkAndAcquireAgentSlot(
  userId: string,
  maxConcurrentAgents: number,
): Promise<boolean> {
  userIdSchema.parse(userId);

  // Auto-release stale slots: if activeAgents > 0 and slotAcquiredAt is older
  // than SLOT_TTL_MS, reset to 0. This handles cases where slots leak during
  // rolling deployments (SIGTERM kills process before releaseAgentSlot runs).
  try {
    const userRecord = await client.send(
      new GetCommand({
        TableName: config.tables.users,
        Key: { userId },
        ProjectionExpression: 'activeAgents, slotAcquiredAt',
      }),
    );
    const active = (userRecord.Item?.activeAgents as number) ?? 0;
    const acquiredAt = (userRecord.Item?.slotAcquiredAt as number) ?? 0;
    if (active > 0 && acquiredAt > 0 && Date.now() - acquiredAt > SLOT_TTL_MS) {
      await client.send(
        new UpdateCommand({
          TableName: config.tables.users,
          Key: { userId },
          UpdateExpression: 'SET activeAgents = :zero, slotAcquiredAt = :now',
          ExpressionAttributeValues: { ':zero': 0, ':now': Date.now() },
        }),
      );
    }
  } catch {
    // Best-effort cleanup — don't block the acquire attempt
  }

  try {
    await client.send(
      new UpdateCommand({
        TableName: config.tables.users,
        Key: { userId },
        UpdateExpression:
          'SET activeAgents = if_not_exists(activeAgents, :zero) + :one, slotAcquiredAt = :now',
        ConditionExpression:
          'attribute_not_exists(activeAgents) OR activeAgents < :max',
        ExpressionAttributeValues: {
          ':zero': 0,
          ':one': 1,
          ':max': maxConcurrentAgents,
          ':now': Date.now(),
        },
      }),
    );
    return true;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === 'ConditionalCheckFailedException'
    ) {
      return false;
    }
    throw err;
  }
}

export async function releaseAgentSlot(userId: string): Promise<void> {
  userIdSchema.parse(userId);
  try {
    await client.send(
      new UpdateCommand({
        TableName: config.tables.users,
        Key: { userId },
        UpdateExpression: 'SET activeAgents = activeAgents - :one',
        ConditionExpression: 'activeAgents > :zero',
        ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
      }),
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === 'ConditionalCheckFailedException'
    ) {
      // Already at zero — log warning but don't throw
      console.warn(`releaseAgentSlot: activeAgents already at 0 for user ${userId}`);
      return;
    }
    throw err;
  }
}

export async function listAllUsers(): Promise<User[]> {
  const items: User[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: config.tables.users,
        ExclusiveStartKey: lastKey,
      }),
    );
    if (result.Items) items.push(...(result.Items as User[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export async function updateUserQuota(
  userId: string,
  quota: Partial<UserQuota>,
): Promise<void> {
  userIdSchema.parse(userId);
  const expressions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  const fields = [
    'maxBots',
    'maxGroupsPerBot',
    'maxTasksPerBot',
    'maxConcurrentAgents',
    'maxMonthlyTokens',
  ] as const;

  for (const field of fields) {
    if (quota[field] !== undefined) {
      expressions.push(`quota.#${field} = :${field}`);
      names[`#${field}`] = field;
      values[`:${field}`] = quota[field];
    }
  }

  if (expressions.length === 0) return;

  await client.send(
    new UpdateCommand({
      TableName: config.tables.users,
      Key: { userId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function updateUserPlan(
  userId: string,
  plan: 'free' | 'pro' | 'enterprise',
): Promise<void> {
  userIdSchema.parse(userId);
  const planQuotas = await getPlanQuotas();
  const quota = planQuotas[plan];
  await client.send(
    new UpdateCommand({
      TableName: config.tables.users,
      Key: { userId },
      UpdateExpression: 'SET #plan = :plan, #quota = :quota',
      ExpressionAttributeNames: { '#plan': 'plan', '#quota': 'quota' },
      ExpressionAttributeValues: { ':plan': plan, ':quota': quota },
    }),
  );
}

/** Create a new User record (admin user provisioning). */
export async function createUserRecord(
  userId: string,
  email: string,
  plan: 'free' | 'pro' | 'enterprise',
): Promise<User> {
  userIdSchema.parse(userId);
  const planQuotas = await getPlanQuotas();
  const now = new Date().toISOString();
  const user: User = {
    userId,
    email,
    displayName: email.split('@')[0],
    plan,
    status: 'active',
    quota: planQuotas[plan],
    usageMonth: now.slice(0, 7), // YYYY-MM
    usageTokens: 0,
    usageInvocations: 0,
    activeAgents: 0,
    createdAt: now,
    lastLogin: now,
  };
  await putUser(user);
  return user;
}

/** Update user status (active or suspended). */
export async function updateUserStatus(
  userId: string,
  status: 'active' | 'suspended',
): Promise<void> {
  userIdSchema.parse(userId);
  await client.send(
    new UpdateCommand({
      TableName: config.tables.users,
      Key: { userId },
      UpdateExpression: 'SET #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status },
    }),
  );
}

/** Soft-delete a user by setting status to 'deleted'. */
export async function softDeleteUser(userId: string): Promise<void> {
  userIdSchema.parse(userId);
  await client.send(
    new UpdateCommand({
      TableName: config.tables.users,
      Key: { userId },
      UpdateExpression: 'SET #status = :deleted',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':deleted': 'deleted' },
    }),
  );
}

// ── Bot operations ──────────────────────────────────────────────────────────

const botKeySchema = z.object({
  userId: z.string().min(1),
  botId: z.string().min(1),
});

export async function createBot(bot: Bot): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: config.tables.bots,
      Item: bot,
      ConditionExpression: 'attribute_not_exists(userId) AND attribute_not_exists(botId)',
    }),
  );
}

export async function getBot(
  userId: string,
  botId: string,
): Promise<Bot | null> {
  botKeySchema.parse({ userId, botId });
  const result = await client.send(
    new GetCommand({
      TableName: config.tables.bots,
      Key: { userId, botId },
    }),
  );
  return (result.Item as Bot) ?? null;
}

export async function getBotById(botId: string): Promise<Bot | null> {
  z.string().min(1).parse(botId);
  const result = await client.send(
    new QueryCommand({
      TableName: config.tables.bots,
      IndexName: 'botId-index',
      KeyConditionExpression: 'botId = :botId',
      ExpressionAttributeValues: { ':botId': botId },
      Limit: 1,
    }),
  );
  return (result.Items?.[0] as Bot) ?? null;
}

export async function listBots(userId: string): Promise<Bot[]> {
  userIdSchema.parse(userId);
  const result = await client.send(
    new QueryCommand({
      TableName: config.tables.bots,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
    }),
  );
  return (result.Items as Bot[]) ?? [];
}

export async function updateBot(
  userId: string,
  botId: string,
  updates: Partial<Bot>,
): Promise<void> {
  botKeySchema.parse({ userId, botId });

  const expressions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  const allowedFields = [
    'name',
    'description',
    'systemPrompt',
    'triggerPattern',
    'providerId',
    'modelId',
    'model',
    'modelProvider',
    'status',
    'containerConfig',
  ] as const;

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      const attrName = `#${field}`;
      const attrValue = `:${field}`;
      expressions.push(`${attrName} = ${attrValue}`);
      names[attrName] = field;
      values[attrValue] = updates[field];
    }
  }

  if (expressions.length === 0) return;

  // Always update updatedAt
  expressions.push('#updatedAt = :updatedAt');
  names['#updatedAt'] = 'updatedAt';
  values[':updatedAt'] = new Date().toISOString();

  await client.send(
    new UpdateCommand({
      TableName: config.tables.bots,
      Key: { userId, botId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function deleteBot(
  userId: string,
  botId: string,
): Promise<void> {
  botKeySchema.parse({ userId, botId });
  await client.send(
    new UpdateCommand({
      TableName: config.tables.bots,
      Key: { userId, botId },
      UpdateExpression: 'SET #status = :deleted, #updatedAt = :now',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':deleted': 'deleted',
        ':now': new Date().toISOString(),
      },
    }),
  );
}

// ── Channel operations ──────────────────────────────────────────────────────

export async function createChannel(channel: ChannelConfig): Promise<void> {
  const channelKey = `${channel.channelType}#${channel.channelId}`;
  await client.send(
    new PutCommand({
      TableName: config.tables.channels,
      Item: { ...channel, channelKey },
    }),
  );
}

export async function getChannel(
  botId: string,
  channelType: string,
  channelId: string,
): Promise<ChannelConfig | null> {
  const channelKey = `${channelType}#${channelId}`;
  const result = await client.send(
    new GetCommand({
      TableName: config.tables.channels,
      Key: { botId, channelKey },
    }),
  );
  return (result.Item as ChannelConfig) ?? null;
}

export async function getChannelsByBot(
  botId: string,
): Promise<ChannelConfig[]> {
  z.string().min(1).parse(botId);
  const result = await client.send(
    new QueryCommand({
      TableName: config.tables.channels,
      KeyConditionExpression: 'botId = :botId',
      ExpressionAttributeValues: { ':botId': botId },
    }),
  );
  return (result.Items as ChannelConfig[]) ?? [];
}

export async function deleteChannel(
  botId: string,
  channelKey: string,
): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: config.tables.channels,
      Key: { botId, channelKey },
    }),
  );
}

export async function updateChannelHealth(
  botId: string,
  channelKey: string,
  healthStatus: string,
  failures: number,
  channelStatus?: string,
): Promise<void> {
  const updateExpr = channelStatus
    ? 'SET healthStatus = :hs, consecutiveFailures = :failures, lastHealthCheck = :now, #s = :cs'
    : 'SET healthStatus = :hs, consecutiveFailures = :failures, lastHealthCheck = :now';
  const values: Record<string, unknown> = {
    ':hs': healthStatus,
    ':failures': failures,
    ':now': new Date().toISOString(),
  };
  if (channelStatus) values[':cs'] = channelStatus;

  await client.send(
    new UpdateCommand({
      TableName: config.tables.channels,
      Key: { botId, channelKey },
      UpdateExpression: updateExpr,
      ExpressionAttributeValues: values,
      ...(channelStatus ? { ExpressionAttributeNames: { '#s': 'status' } } : {}),
    }),
  );
}

export async function getChannelsNeedingHealthCheck(): Promise<ChannelConfig[]> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const results: ChannelConfig[] = [];

  // Query healthCheckIndex GSI for healthy channels not checked in the last hour
  const healthyResult = await client.send(
    new QueryCommand({
      TableName: config.tables.channels,
      IndexName: 'healthCheckIndex',
      KeyConditionExpression:
        'healthStatus = :status AND lastHealthCheck < :cutoff',
      ExpressionAttributeValues: {
        ':status': 'healthy',
        ':cutoff': oneHourAgo,
      },
    }),
  );
  if (healthyResult.Items) {
    results.push(...(healthyResult.Items as ChannelConfig[]));
  }

  // Query unhealthy channels with consecutiveFailures < 3 (still worth retrying)
  const unhealthyResult = await client.send(
    new QueryCommand({
      TableName: config.tables.channels,
      IndexName: 'healthCheckIndex',
      KeyConditionExpression:
        'healthStatus = :status AND lastHealthCheck < :cutoff',
      FilterExpression: 'consecutiveFailures < :maxFailures',
      ExpressionAttributeValues: {
        ':status': 'unhealthy',
        ':cutoff': oneHourAgo,
        ':maxFailures': 3,
      },
    }),
  );
  if (unhealthyResult.Items) {
    results.push(...(unhealthyResult.Items as ChannelConfig[]));
  }

  // Also pick up channels that have never been health-checked (lastHealthCheck not set)
  // These won't appear in the GSI, so we scan with a filter
  const uncheckedResult = await client.send(
    new ScanCommand({
      TableName: config.tables.channels,
      FilterExpression: 'attribute_not_exists(lastHealthCheck)',
    }),
  );
  if (uncheckedResult.Items) {
    results.push(...(uncheckedResult.Items as ChannelConfig[]));
  }

  return results;
}

// ── Group operations ────────────────────────────────────────────────────────

export async function getGroup(
  botId: string,
  groupJid: string,
): Promise<Group | null> {
  const result = await client.send(
    new GetCommand({
      TableName: config.tables.groups,
      Key: { botId, groupJid },
    }),
  );
  return (result.Item as Group) ?? null;
}

export async function getOrCreateGroup(
  botId: string,
  groupJid: string,
  name: string,
  channelType: string,
  isGroup: boolean,
): Promise<Group> {
  // Try to get existing group first
  const existing = await client.send(
    new GetCommand({
      TableName: config.tables.groups,
      Key: { botId, groupJid },
    }),
  );

  if (existing.Item) {
    // Update lastMessageAt
    await client.send(
      new UpdateCommand({
        TableName: config.tables.groups,
        Key: { botId, groupJid },
        UpdateExpression: 'SET lastMessageAt = :now, #name = :name',
        ExpressionAttributeNames: { '#name': 'name' },
        ExpressionAttributeValues: {
          ':now': new Date().toISOString(),
          ':name': name,
        },
      }),
    );
    return existing.Item as Group;
  }

  // Create new group
  const group: Group = {
    botId,
    groupJid,
    name,
    channelType: channelType as Group['channelType'],
    isGroup,
    requiresTrigger: isGroup, // groups require @mention, DMs don't
    lastMessageAt: new Date().toISOString(),
    sessionStatus: 'idle',
  };

  await client.send(
    new PutCommand({
      TableName: config.tables.groups,
      Item: group,
    }),
  );

  return group;
}

export async function listGroups(botId: string): Promise<Group[]> {
  z.string().min(1).parse(botId);
  const result = await client.send(
    new QueryCommand({
      TableName: config.tables.groups,
      KeyConditionExpression: 'botId = :botId',
      ExpressionAttributeValues: { ':botId': botId },
    }),
  );
  return (result.Items as Group[]) ?? [];
}

export async function updateGroup(
  botId: string,
  groupJid: string,
  updates: { name?: string; requiresTrigger?: boolean },
): Promise<void> {
  const expressions: string[] = [];
  const values: Record<string, unknown> = {};
  if (updates.name !== undefined) {
    expressions.push('#n = :n');
    values[':n'] = updates.name;
  }
  if (updates.requiresTrigger !== undefined) {
    expressions.push('requiresTrigger = :rt');
    values[':rt'] = updates.requiresTrigger;
  }
  if (expressions.length === 0) return;
  await client.send(
    new UpdateCommand({
      TableName: config.tables.groups,
      Key: { botId, groupJid },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeValues: values,
      ...(updates.name !== undefined
        ? { ExpressionAttributeNames: { '#n': 'name' } }
        : {}),
    }),
  );
}

export async function updateGroupSession(
  botId: string,
  groupJid: string,
  sessionId: string,
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: config.tables.groups,
      Key: { botId, groupJid },
      UpdateExpression:
        'SET agentcoreSessionId = :sid, sessionStatus = :status',
      ExpressionAttributeValues: {
        ':sid': sessionId,
        ':status': 'active',
      },
    }),
  );
}

// ── Message operations ──────────────────────────────────────────────────────

export async function putMessage(msg: Message): Promise<void> {
  const pk = `${msg.botId}#${msg.groupJid}`;
  await client.send(
    new PutCommand({
      TableName: config.tables.messages,
      Item: {
        pk,
        ...msg,
        ttl: msg.ttl || ttl90Days(),
      },
    }),
  );
}

export async function getRecentMessages(
  botId: string,
  groupJid: string,
  limit: number = 50,
): Promise<Message[]> {
  const pk = `${botId}#${groupJid}`;
  const result = await client.send(
    new QueryCommand({
      TableName: config.tables.messages,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ScanIndexForward: false, // newest first
      Limit: limit,
    }),
  );

  // Reverse to chronological order (oldest first)
  const messages = (result.Items as Message[]) ?? [];
  return messages.reverse();
}

// ── Task operations ─────────────────────────────────────────────────────────

export async function createTask(task: ScheduledTask): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: config.tables.tasks,
      Item: task,
    }),
  );
}

export async function getTask(
  botId: string,
  taskId: string,
): Promise<ScheduledTask | null> {
  const result = await client.send(
    new GetCommand({
      TableName: config.tables.tasks,
      Key: { botId, taskId },
    }),
  );
  return (result.Item as ScheduledTask) ?? null;
}

export async function listTasks(botId: string): Promise<ScheduledTask[]> {
  z.string().min(1).parse(botId);
  const result = await client.send(
    new QueryCommand({
      TableName: config.tables.tasks,
      KeyConditionExpression: 'botId = :botId',
      ExpressionAttributeValues: { ':botId': botId },
    }),
  );
  return (result.Items as ScheduledTask[]) ?? [];
}

export async function updateTask(
  botId: string,
  taskId: string,
  updates: Partial<ScheduledTask>,
): Promise<void> {
  const expressions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  const allowedFields = [
    'prompt',
    'scheduleValue',
    'status',
    'nextRun',
    'lastRun',
    'lastResult',
    'eventbridgeScheduleArn',
  ] as const;

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      const attrName = `#${field}`;
      const attrValue = `:${field}`;
      expressions.push(`${attrName} = ${attrValue}`);
      names[attrName] = field;
      values[attrValue] = updates[field];
    }
  }

  if (expressions.length === 0) return;

  await client.send(
    new UpdateCommand({
      TableName: config.tables.tasks,
      Key: { botId, taskId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function deleteTask(
  botId: string,
  taskId: string,
): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: config.tables.tasks,
      Key: { botId, taskId },
    }),
  );
}

// ── Session operations ──────────────────────────────────────────────────────

export async function getSession(
  botId: string,
  groupJid: string,
): Promise<Session | null> {
  const pk = `${botId}#${groupJid}`;
  const result = await client.send(
    new GetCommand({
      TableName: config.tables.sessions,
      Key: { pk, sk: 'current' },
    }),
  );
  return (result.Item as Session) ?? null;
}

export async function putSession(session: Session): Promise<void> {
  const pk = `${session.botId}#${session.groupJid}`;
  await client.send(
    new PutCommand({
      TableName: config.tables.sessions,
      Item: { pk, sk: 'current', ...session },
    }),
  );
}

// ── Plan Quotas (system config) ─────────────────────────────────────────────

/**
 * Read the system-wide plan quotas from DynamoDB.
 * Falls back to the built-in PLAN_QUOTAS defaults if no record exists.
 */
export async function getPlanQuotas(): Promise<PlanQuotas> {
  const result = await client.send(
    new GetCommand({
      TableName: config.tables.sessions,
      Key: { pk: '__system__', sk: 'plan-quotas' },
    }),
  );
  return (result.Item?.quotas as PlanQuotas) ?? PLAN_QUOTAS;
}

/**
 * Write/overwrite the system-wide plan quotas in DynamoDB.
 */
export async function savePlanQuotas(quotas: PlanQuotas): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: config.tables.sessions,
      Item: {
        pk: '__system__',
        sk: 'plan-quotas',
        quotas,
      },
    }),
  );
}

// ── Provider operations (global, admin-managed) ──────────────────────────

const providerIdSchema = z.string().min(1, 'providerId is required');

export async function getProvider(providerId: string): Promise<Provider | null> {
  providerIdSchema.parse(providerId);
  const result = await client.send(
    new GetCommand({
      TableName: config.tables.providers,
      Key: { providerId },
    }),
  );
  return (result.Item as Provider) ?? null;
}

export async function listProviders(): Promise<Provider[]> {
  const items: Provider[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: config.tables.providers,
        ExclusiveStartKey: lastKey,
      }),
    );
    if (result.Items) items.push(...(result.Items as Provider[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export async function putProvider(provider: Provider): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: config.tables.providers,
      Item: provider,
    }),
  );
}

export async function updateProvider(
  providerId: string,
  updates: Partial<Pick<Provider, 'providerName' | 'providerType' | 'baseUrl' | 'hasApiKey' | 'modelIds' | 'isDefault' | 'updatedAt'>>,
): Promise<void> {
  providerIdSchema.parse(providerId);

  const expressions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  const allowedFields = [
    'providerName',
    'providerType',
    'baseUrl',
    'hasApiKey',
    'modelIds',
    'isDefault',
    'updatedAt',
  ] as const;

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      const attrName = `#${field}`;
      const attrValue = `:${field}`;
      expressions.push(`${attrName} = ${attrValue}`);
      names[attrName] = field;
      values[attrValue] = updates[field];
    }
  }

  if (expressions.length === 0) return;

  await client.send(
    new UpdateCommand({
      TableName: config.tables.providers,
      Key: { providerId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function deleteProvider(providerId: string): Promise<void> {
  providerIdSchema.parse(providerId);
  await client.send(
    new DeleteCommand({
      TableName: config.tables.providers,
      Key: { providerId },
    }),
  );
}

/** Clear the isDefault flag on all providers that currently have it set. */
export async function clearDefaultProvider(): Promise<void> {
  const all = await listProviders();
  const defaults = all.filter((p) => p.isDefault);
  for (const p of defaults) {
    await updateProvider(p.providerId, {
      isDefault: false,
      updatedAt: new Date().toISOString(),
    });
  }
}
