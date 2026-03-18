/**
 * ClawBot Cloud — MCP Tool Implementations
 *
 * Cloud-native port of NanoClaw's IPC-based MCP tools (ipc-mcp-stdio.ts).
 * Instead of writing JSON files to /workspace/ipc/ for the host to pick up,
 * these call AWS services directly via scoped credentials:
 *
 *   send_message   → SQS reply queue (control plane routes to channel)
 *   schedule_task  → DynamoDB + EventBridge Scheduler
 *   list_tasks     → DynamoDB query
 *   pause_task     → DynamoDB update + disable EventBridge schedule
 *   resume_task    → DynamoDB update + enable EventBridge schedule
 *   cancel_task    → DynamoDB delete + delete EventBridge schedule
 *   update_task    → DynamoDB update + update EventBridge schedule
 */

import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
} from '@aws-sdk/client-scheduler';
import { CronExpressionParser } from 'cron-parser';
import type { ScopedClients } from './scoped-credentials.js';
import type { ScheduledTask, SqsTextReplyPayload, SqsFileReplyPayload, ChannelType } from '@clawbot/shared';

const REPLY_QUEUE_URL = process.env.SQS_REPLIES_URL || '';
const TASKS_TABLE = process.env.TABLE_TASKS || '';
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN || '';
const MESSAGES_QUEUE_ARN = process.env.SQS_MESSAGES_ARN || '';
const SESSION_BUCKET = process.env.SESSION_BUCKET || '';

export interface McpToolContext {
  botId: string;
  botName: string;
  groupJid: string;
  userId: string;
  channelType: ChannelType;
  clients: ScopedClients;
}

// ---------------------------------------------------------------------------
// send_message — Send a message to a chat
// Replaces NanoClaw's IPC /workspace/ipc/messages/*.json
// ---------------------------------------------------------------------------

export async function sendMessage(
  ctx: McpToolContext,
  text: string,
  sender?: string,
): Promise<void> {
  const payload: SqsTextReplyPayload = {
    type: 'reply',
    botId: ctx.botId,
    groupJid: ctx.groupJid,
    channelType: ctx.channelType,
    text,
    timestamp: new Date().toISOString(),
  };

  // Reply queue uses the runtime's own credentials (not scoped)
  const sqs = new SQSClient({});
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: REPLY_QUEUE_URL,
      MessageBody: JSON.stringify(payload),
      MessageAttributes: sender
        ? { sender: { DataType: 'String', StringValue: sender } }
        : undefined,
    }),
  );
}

// ---------------------------------------------------------------------------
// send_file — Send a file to a chat
// Uploads to S3, then sends an SqsFileReplyPayload to the reply queue
// so the control plane can deliver it via the appropriate channel adapter.
// ---------------------------------------------------------------------------

export async function sendFile(
  ctx: McpToolContext,
  filePath: string,
  caption?: string,
): Promise<void> {
  // 1. Validate path is under /workspace/group/ (resolve symlinks for security)
  const resolved = await realpath(filePath);
  if (!resolved.startsWith('/workspace/group/')) {
    throw new Error('File must be under /workspace/group/');
  }

  // 2. Read file as Buffer, check size
  const fileBuffer = await readFile(resolved);
  const MAX_SIZE = 25 * 1024 * 1024; // 25MB
  if (fileBuffer.length > MAX_SIZE) {
    throw new Error(
      `File too large (${(fileBuffer.length / 1024 / 1024).toFixed(1)}MB). Maximum is 25MB.`,
    );
  }

  // 3. Guess mimeType from extension
  const fileName = path.basename(resolved);
  const mimeType = guessMimeType(fileName);

  // 4. Upload to S3 via scoped credentials
  const messageId = `file-${Date.now()}`;
  const s3Key = `${ctx.userId}/${ctx.botId}/attachments/${messageId}/${fileName}`;
  await ctx.clients.s3.send(
    new PutObjectCommand({
      Bucket: SESSION_BUCKET,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: mimeType,
    }),
  );

  // 5. Send SqsFileReplyPayload to reply queue (uses runtime's own credentials)
  const payload: SqsFileReplyPayload = {
    type: 'file_reply',
    botId: ctx.botId,
    groupJid: ctx.groupJid,
    channelType: ctx.channelType,
    s3Key,
    fileName,
    mimeType,
    size: fileBuffer.length,
    caption,
    timestamp: new Date().toISOString(),
  };

  const sqs = new SQSClient({});
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: REPLY_QUEUE_URL,
      MessageBody: JSON.stringify(payload),
    }),
  );
}

function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.zip': 'application/zip',
    '.csv': 'text/csv',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.html': 'text/html',
    '.md': 'text/markdown',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// schedule_task — Create a scheduled task
// Replaces NanoClaw's IPC /workspace/ipc/tasks/*.json with type=schedule_task
// ---------------------------------------------------------------------------

export async function scheduleTask(
  ctx: McpToolContext,
  prompt: string,
  scheduleType: 'cron' | 'interval' | 'once',
  scheduleValue: string,
  contextMode: 'group' | 'isolated' = 'group',
): Promise<string> {
  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  // 1. Write task record to DynamoDB
  const task: ScheduledTask = {
    botId: ctx.botId,
    taskId,
    groupJid: ctx.groupJid,
    prompt,
    scheduleType,
    scheduleValue,
    contextMode,
    status: 'active',
    nextRun: computeNextRun(scheduleType, scheduleValue),
    lastRun: undefined,
    lastResult: undefined,
    createdAt: now,
  };

  await ctx.clients.dynamodb.send(
    new PutCommand({
      TableName: TASKS_TABLE,
      Item: task,
    }),
  );

  // 2. Create EventBridge Scheduler schedule
  const scheduleName = `nanoclawbot-${ctx.botId}-${taskId}`;
  const scheduleExpression = toEventBridgeExpression(scheduleType, scheduleValue);

  await ctx.clients.scheduler.send(
    new CreateScheduleCommand({
      Name: scheduleName,
      ScheduleExpression: scheduleExpression,
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: MESSAGES_QUEUE_ARN,
        RoleArn: SCHEDULER_ROLE_ARN,
        Input: JSON.stringify({
          type: 'scheduled_task',
          botId: ctx.botId,
          groupJid: ctx.groupJid,
          userId: ctx.userId,
          taskId,
          timestamp: now,
        }),
        SqsParameters: {
          MessageGroupId: `${ctx.botId}#${ctx.groupJid}`,
        },
      },
    }),
  );

  return taskId;
}

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

export async function listTasks(ctx: McpToolContext): Promise<ScheduledTask[]> {
  const result = await ctx.clients.dynamodb.send(
    new QueryCommand({
      TableName: TASKS_TABLE,
      KeyConditionExpression: 'botId = :bid',
      ExpressionAttributeValues: { ':bid': ctx.botId },
    }),
  );
  return (result.Items ?? []) as ScheduledTask[];
}

// ---------------------------------------------------------------------------
// pause_task
// ---------------------------------------------------------------------------

export async function pauseTask(ctx: McpToolContext, taskId: string): Promise<void> {
  // Fetch current task to get its schedule expression
  const existing = await getTask(ctx, taskId);

  await ctx.clients.dynamodb.send(
    new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { botId: ctx.botId, taskId },
      UpdateExpression: 'SET #s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'paused' },
    }),
  );

  const scheduleName = `nanoclawbot-${ctx.botId}-${taskId}`;
  const scheduleExpression = existing
    ? toEventBridgeExpression(existing.scheduleType, existing.scheduleValue)
    : 'rate(1 day)';

  await ctx.clients.scheduler.send(
    new UpdateScheduleCommand({
      Name: scheduleName,
      State: 'DISABLED',
      ScheduleExpression: scheduleExpression,
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: MESSAGES_QUEUE_ARN,
        RoleArn: SCHEDULER_ROLE_ARN,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// resume_task
// ---------------------------------------------------------------------------

export async function resumeTask(ctx: McpToolContext, taskId: string): Promise<void> {
  const existing = await getTask(ctx, taskId);

  await ctx.clients.dynamodb.send(
    new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { botId: ctx.botId, taskId },
      UpdateExpression: 'SET #s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'active' },
    }),
  );

  const scheduleName = `nanoclawbot-${ctx.botId}-${taskId}`;
  const scheduleExpression = existing
    ? toEventBridgeExpression(existing.scheduleType, existing.scheduleValue)
    : 'rate(1 day)';

  await ctx.clients.scheduler.send(
    new UpdateScheduleCommand({
      Name: scheduleName,
      State: 'ENABLED',
      ScheduleExpression: scheduleExpression,
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: MESSAGES_QUEUE_ARN,
        RoleArn: SCHEDULER_ROLE_ARN,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// cancel_task
// ---------------------------------------------------------------------------

export async function cancelTask(ctx: McpToolContext, taskId: string): Promise<void> {
  await ctx.clients.dynamodb.send(
    new DeleteCommand({
      TableName: TASKS_TABLE,
      Key: { botId: ctx.botId, taskId },
    }),
  );

  const scheduleName = `nanoclawbot-${ctx.botId}-${taskId}`;
  try {
    await ctx.clients.scheduler.send(new DeleteScheduleCommand({ Name: scheduleName }));
  } catch {
    // Schedule may not exist yet or already deleted — safe to ignore
  }
}

// ---------------------------------------------------------------------------
// update_task
// ---------------------------------------------------------------------------

export async function updateTask(
  ctx: McpToolContext,
  taskId: string,
  updates: { prompt?: string; scheduleType?: 'cron' | 'interval' | 'once'; scheduleValue?: string },
): Promise<void> {
  const expressions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  if (updates.prompt !== undefined) {
    expressions.push('#p = :p');
    names['#p'] = 'prompt';
    values[':p'] = updates.prompt;
  }
  if (updates.scheduleType !== undefined) {
    expressions.push('#st = :st');
    names['#st'] = 'scheduleType';
    values[':st'] = updates.scheduleType;
  }
  if (updates.scheduleValue !== undefined) {
    expressions.push('#sv = :sv');
    names['#sv'] = 'scheduleValue';
    values[':sv'] = updates.scheduleValue;
  }

  if (expressions.length === 0) return;

  await ctx.clients.dynamodb.send(
    new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { botId: ctx.botId, taskId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );

  // If schedule changed, update EventBridge
  if (updates.scheduleType || updates.scheduleValue) {
    const existing = await getTask(ctx, taskId);
    if (existing) {
      const scheduleName = `nanoclawbot-${ctx.botId}-${taskId}`;
      const scheduleExpression = toEventBridgeExpression(
        existing.scheduleType,
        existing.scheduleValue,
      );

      await ctx.clients.scheduler.send(
        new UpdateScheduleCommand({
          Name: scheduleName,
          State: 'ENABLED',
          ScheduleExpression: scheduleExpression,
          FlexibleTimeWindow: { Mode: 'OFF' },
          Target: {
            Arn: MESSAGES_QUEUE_ARN,
            RoleArn: SCHEDULER_ROLE_ARN,
            Input: JSON.stringify({
              type: 'scheduled_task',
              botId: ctx.botId,
              groupJid: ctx.groupJid,
              userId: ctx.userId,
              taskId,
              timestamp: new Date().toISOString(),
            }),
            SqsParameters: {
              MessageGroupId: `${ctx.botId}#${ctx.groupJid}`,
            },
          },
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getTask(ctx: McpToolContext, taskId: string): Promise<ScheduledTask | null> {
  const result = await ctx.clients.dynamodb.send(
    new GetCommand({
      TableName: TASKS_TABLE,
      Key: { botId: ctx.botId, taskId },
    }),
  );
  return (result.Item as ScheduledTask) ?? null;
}

/**
 * Compute the next run time for a schedule.
 */
function computeNextRun(scheduleType: string, scheduleValue: string): string | undefined {
  const now = new Date();
  switch (scheduleType) {
    case 'cron': {
      try {
        const interval = CronExpressionParser.parse(scheduleValue);
        return interval.next().toISOString() ?? undefined;
      } catch {
        return undefined;
      }
    }
    case 'interval': {
      const ms = Number(scheduleValue);
      if (isNaN(ms) || ms <= 0) return undefined;
      return new Date(now.getTime() + ms).toISOString();
    }
    case 'once': {
      return scheduleValue; // ISO timestamp
    }
    default:
      return undefined;
  }
}

/**
 * Convert NanoClaw schedule format to EventBridge Scheduler expression.
 *
 * NanoClaw cron: 5-field (minute hour dom month dow)
 * EventBridge:   6-field cron (minute hour dom month dow year)
 * Interval:      rate(N minutes)
 * Once:          at(ISO timestamp)
 */
function toEventBridgeExpression(scheduleType: string, scheduleValue: string): string {
  switch (scheduleType) {
    case 'cron':
      // Append wildcard year to convert 5-field → 6-field
      return `cron(${scheduleValue} *)`;
    case 'interval': {
      const ms = Number(scheduleValue);
      const minutes = Math.max(1, Math.round(ms / 60000));
      return `rate(${minutes} ${minutes === 1 ? 'minute' : 'minutes'})`;
    }
    case 'once':
      return `at(${scheduleValue})`;
    default:
      throw new Error(`Unknown schedule type: ${scheduleType}`);
  }
}

// ---------------------------------------------------------------------------
// Validation helpers (used by mcp-server.ts before calling tool functions)
// ---------------------------------------------------------------------------

export function validateCron(value: string): string | null {
  try {
    CronExpressionParser.parse(value);
    return null;
  } catch {
    return `Invalid cron: "${value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`;
  }
}

export function validateInterval(value: string): string | null {
  const ms = parseInt(value, 10);
  if (isNaN(ms) || ms <= 0) {
    return `Invalid interval: "${value}". Must be positive milliseconds (e.g., "300000" for 5 min).`;
  }
  return null;
}

export function validateOnce(value: string): string | null {
  if (/[Zz]$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value)) {
    return `Timestamp must be local time without timezone suffix. Got "${value}" — use format like "2026-02-01T15:30:00".`;
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return `Invalid timestamp: "${value}". Use local time format like "2026-02-01T15:30:00".`;
  }
  return null;
}
