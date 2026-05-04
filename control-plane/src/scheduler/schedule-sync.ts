// ClawBot Cloud — EventBridge Scheduler self-heal helper
//
// Keeps EventBridge Scheduler state aligned with DynamoDB task status.
// Used as a defensive heal from the dispatcher: when a queued scheduled_task
// fires for a bot/task that is no longer active, we disable the upstream
// schedule so it stops producing phantom SQS messages. The tasks.ts PATCH
// handler is still the primary owner of schedule state — this is just a
// safety net for drift (manual DB edits, failed writes, old deployments).

import {
  SchedulerClient,
  GetScheduleCommand,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';
import { config } from '../config.js';
import type { Logger } from 'pino';

let clientSingleton: SchedulerClient | null = null;

function getClient(): SchedulerClient {
  if (!clientSingleton) {
    clientSingleton = new SchedulerClient({ region: config.region });
  }
  return clientSingleton;
}

export function schedulerConfigured(): boolean {
  return !!(config.scheduler?.roleArn && config.scheduler?.messageQueueArn);
}

export function scheduleNameFor(botId: string, taskId: string): string {
  return `nanoclawbot-${botId}-${taskId}`;
}

/**
 * Best-effort disable of an EventBridge schedule that is still firing for a
 * paused/missing task. Never throws — logs and swallows all errors.
 */
export async function disableOrphanedSchedule(
  botId: string,
  taskId: string,
  logger: Logger,
): Promise<void> {
  if (!schedulerConfigured()) return;

  const scheduleName = scheduleNameFor(botId, taskId);
  const client = getClient();

  try {
    const current = await client.send(
      new GetScheduleCommand({ Name: scheduleName }),
    );
    if (current.State === 'DISABLED') return;

    await client.send(
      new UpdateScheduleCommand({
        Name: scheduleName,
        ScheduleExpression: current.ScheduleExpression!,
        ScheduleExpressionTimezone: current.ScheduleExpressionTimezone || 'UTC',
        FlexibleTimeWindow: current.FlexibleTimeWindow || { Mode: 'OFF' },
        Target: current.Target!,
        State: 'DISABLED',
        ActionAfterCompletion: current.ActionAfterCompletion,
      }),
    );
    logger.warn(
      { botId, taskId, scheduleName },
      'Disabled orphaned EventBridge schedule (task no longer active)',
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') {
      return;
    }
    logger.warn(
      { err, botId, taskId, scheduleName },
      'Best-effort disableOrphanedSchedule failed',
    );
  }
}

// Test-only hook so module can be re-imported with a fresh client
export function __resetForTests(): void {
  clientSingleton = null;
}
