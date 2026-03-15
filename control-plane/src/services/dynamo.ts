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
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { config } from '../config.js';
import type {
  Bot,
  ChannelConfig,
  Group,
  Message,
  ScheduledTask,
  Session,
  User,
} from '@clawbot/shared';

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

export async function updateUserUsage(
  userId: string,
  tokensUsed: number,
): Promise<void> {
  userIdSchema.parse(userId);
  const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  await client.send(
    new UpdateCommand({
      TableName: config.tables.users,
      Key: { userId },
      UpdateExpression: `
        SET usageTokens = if_not_exists(usageTokens, :zero) + :tokens,
            usageInvocations = if_not_exists(usageInvocations, :zero) + :one,
            usageMonth = :month,
            lastLogin = :now
      `,
      ExpressionAttributeValues: {
        ':tokens': tokensUsed,
        ':one': 1,
        ':zero': 0,
        ':month': currentMonth,
        ':now': new Date().toISOString(),
      },
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
  status: string,
  failures: number,
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: config.tables.channels,
      Key: { botId, channelKey },
      UpdateExpression:
        'SET healthStatus = :status, consecutiveFailures = :failures',
      ExpressionAttributeValues: {
        ':status': status,
        ':failures': failures,
      },
    }),
  );
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
