// ClawBot Cloud — Tasks API Routes
// CRUD operations for scheduled task management with EventBridge Scheduler integration

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  UpdateScheduleCommand,
  GetScheduleCommand,
} from '@aws-sdk/client-scheduler';
import {
  getBot,
  getUser,
  createTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
} from '../../services/dynamo.js';
import { config } from '../../config.js';
import type {
  ScheduledTask,
  CreateTaskRequest,
  UpdateTaskRequest,
  SqsTaskPayload,
} from '@clawbot/shared';

const scheduler = new SchedulerClient({ region: config.region });

const createTaskSchema = z.object({
  groupJid: z.string().min(1),
  prompt: z.string().min(1).max(5000),
  scheduleType: z.enum(['cron', 'interval', 'once']),
  scheduleValue: z.string().min(1),
  contextMode: z.enum(['group', 'isolated']).optional(),
});

const updateTaskSchema = z.object({
  status: z.enum(['active', 'paused']).optional(),
  prompt: z.string().min(1).max(5000).optional(),
  scheduleValue: z.string().min(1).optional(),
});

/**
 * Convert a task's schedule type and value into an EventBridge Scheduler expression.
 */
function toScheduleExpression(
  scheduleType: 'cron' | 'interval' | 'once',
  scheduleValue: string,
): string {
  switch (scheduleType) {
    case 'cron':
      // Cron value is stored in AWS 6-field format — pass through directly
      return `cron(${scheduleValue})`;
    case 'interval': {
      const minutes = Math.round(parseInt(scheduleValue, 10) / 60000);
      return `rate(${minutes} minutes)`;
    }
    case 'once':
      return `at(${scheduleValue})`;
  }
}

function schedulerConfigured(): boolean {
  return !!(config.scheduler.roleArn && config.scheduler.messageQueueArn);
}

export const tasksRoutes: FastifyPluginAsync = async (app) => {
  // List tasks for a bot
  app.get<{ Params: { botId: string } }>('/', async (request, reply) => {
    const { botId } = request.params;

    const bot = await getBot(request.userId, botId);
    if (!bot || bot.status === 'deleted') {
      return reply.status(404).send({ error: 'Bot not found' });
    }

    const tasks = await listTasks(botId);
    return tasks;
  });

  // Create a new task
  app.post<{ Params: { botId: string } }>('/', async (request, reply) => {
    const { botId } = request.params;

    const bot = await getBot(request.userId, botId);
    if (!bot || bot.status === 'deleted') {
      return reply.status(404).send({ error: 'Bot not found' });
    }

    const body = createTaskSchema.parse(request.body as CreateTaskRequest);

    // Quota check: ensure user hasn't exceeded max tasks per bot
    const user = await getUser(request.userId);
    if (user) {
      const existingTasks = await listTasks(botId);
      const activeTasks = existingTasks.filter((t) => t.status !== 'completed');
      if (activeTasks.length >= user.quota.maxTasksPerBot) {
        return reply.status(403).send({ error: 'Task limit reached for this bot. Upgrade your plan to create more tasks.' });
      }
    }

    const now = new Date().toISOString();
    const taskId = ulid();

    const task: ScheduledTask = {
      botId,
      taskId,
      groupJid: body.groupJid,
      prompt: body.prompt,
      scheduleType: body.scheduleType,
      scheduleValue: body.scheduleValue,
      contextMode: body.contextMode || 'isolated',
      status: 'active',
      createdAt: now,
    };

    // Create EventBridge Schedule if scheduler is configured
    if (schedulerConfigured()) {
      const scheduleName = `nanoclawbot-${botId}-${taskId}`;
      const expression = toScheduleExpression(
        body.scheduleType,
        body.scheduleValue,
      );

      const sqsPayload: SqsTaskPayload = {
        type: 'scheduled_task',
        botId,
        groupJid: body.groupJid,
        userId: request.userId,
        taskId,
        timestamp: now,
      };

      const result = await scheduler.send(
        new CreateScheduleCommand({
          Name: scheduleName,
          ScheduleExpression: expression,
          ScheduleExpressionTimezone: 'UTC',
          State: 'ENABLED',
          FlexibleTimeWindow: { Mode: 'OFF' },
          ActionAfterCompletion:
            body.scheduleType === 'once' ? 'DELETE' : 'NONE',
          Target: {
            Arn: config.scheduler.messageQueueArn,
            RoleArn: config.scheduler.roleArn,
            Input: JSON.stringify(sqsPayload),
            SqsParameters: {
              MessageGroupId: `${botId}#${body.groupJid}`,
            },
          },
        }),
      );

      task.eventbridgeScheduleArn = result.ScheduleArn;
    }

    await createTask(task);
    return reply.status(201).send(task);
  });

  // Get a specific task
  app.get<{ Params: { botId: string; taskId: string } }>(
    '/:taskId',
    async (request, reply) => {
      const { botId, taskId } = request.params;

      const bot = await getBot(request.userId, botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const task = await getTask(botId, taskId);
      if (!task) {
        return reply.status(404).send({ error: 'Task not found' });
      }

      return task;
    },
  );

  // Update a task (pause/resume via status change)
  app.patch<{ Params: { botId: string; taskId: string } }>(
    '/:taskId',
    async (request, reply) => {
      const { botId, taskId } = request.params;

      const bot = await getBot(request.userId, botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const existing = await getTask(botId, taskId);
      if (!existing) {
        return reply.status(404).send({ error: 'Task not found' });
      }

      const updates = updateTaskSchema.parse(
        request.body as UpdateTaskRequest,
      );

      // Update EventBridge Schedule when status OR schedule changes
      if ((updates.status || updates.scheduleValue) && schedulerConfigured()) {
        const scheduleName = `nanoclawbot-${botId}-${taskId}`;

        try {
          // Get current schedule to preserve all fields (UpdateSchedule overwrites everything)
          const current = await scheduler.send(
            new GetScheduleCommand({ Name: scheduleName }),
          );

          // Compute new expression if schedule changed
          const newExpression = updates.scheduleValue
            ? toScheduleExpression(existing.scheduleType, updates.scheduleValue)
            : current.ScheduleExpression!;

          await scheduler.send(
            new UpdateScheduleCommand({
              Name: scheduleName,
              ScheduleExpression: newExpression,
              ScheduleExpressionTimezone:
                current.ScheduleExpressionTimezone || 'UTC',
              FlexibleTimeWindow: current.FlexibleTimeWindow || {
                Mode: 'OFF',
              },
              Target: current.Target!,
              State: updates.status === 'paused' ? 'DISABLED' : (updates.status === 'active' ? 'ENABLED' : current.State),
              ActionAfterCompletion: current.ActionAfterCompletion,
            }),
          );
        } catch (err: unknown) {
          if (
            err instanceof Error &&
            err.name === 'ResourceNotFoundException'
          ) {
            request.log.warn({ scheduleName }, 'EventBridge schedule not found — skipping update');
          } else {
            throw err;
          }
        }
      }

      await updateTask(botId, taskId, updates);
      const updated = await getTask(botId, taskId);
      return updated;
    },
  );

  // Delete a task
  app.delete<{ Params: { botId: string; taskId: string } }>(
    '/:taskId',
    async (request, reply) => {
      const { botId, taskId } = request.params;

      const bot = await getBot(request.userId, botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const existing = await getTask(botId, taskId);
      if (!existing) {
        return reply.status(404).send({ error: 'Task not found' });
      }

      // Delete EventBridge Schedule if scheduler is configured
      if (schedulerConfigured()) {
        const scheduleName = `nanoclawbot-${botId}-${taskId}`;
        try {
          await scheduler.send(
            new DeleteScheduleCommand({ Name: scheduleName }),
          );
        } catch (err: unknown) {
          // Ignore if schedule doesn't exist (already deleted or never created)
          if (
            !(
              err instanceof Error && err.name === 'ResourceNotFoundException'
            )
          ) {
            throw err;
          }
        }
      }

      await deleteTask(botId, taskId);
      return reply.status(204).send();
    },
  );
};
