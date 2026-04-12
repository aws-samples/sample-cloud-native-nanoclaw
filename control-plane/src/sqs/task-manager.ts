// ClawBot Cloud — ECS Task Manager
// Manages warm pool of pre-started Fargate tasks and per-session task assignment.
// Warm tasks are idle containers ready for instant dispatch; when a session needs
// a task we claim from the pool first, falling back to cold-start RunTask + poll.

import {
  ECSClient,
  RunTaskCommand,
  DescribeTasksCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import { config } from '../config.js';
import {
  countWarmTasks,
  deleteWarmTask,
  claimWarmTask,
  getWarmTaskByArn,
  assignTaskToSession,
  clearSessionTask,
  scanIdleSessionTasks,
  acquireReplenishLock,
  releaseReplenishLock,
} from '../services/dynamo.js';
import type { Logger } from 'pino';

const ecs = new ECSClient({ region: config.region });

let replenishTimer: ReturnType<typeof setInterval> | null = null;
let idleScanTimer: ReturnType<typeof setInterval> | null = null;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Assign (or start) a dedicated ECS task for the given session.
 * 1. Try to claim a warm task from the pool.
 * 2. If none available, cold-start a new task via RunTask and poll until it
 *    registers itself in DynamoDB.
 * Returns the private IP of the assigned task.
 */
export async function assignTaskForSession(
  botId: string,
  groupJid: string,
  logger: Logger,
): Promise<string> {
  // Attempt warm claim first
  const warm = await claimWarmTask();
  if (warm) {
    logger.info(
      { taskArn: warm.taskArn, taskIp: warm.taskIp },
      'Claimed warm task for session',
    );
    await assignTaskToSession(botId, groupJid, warm.taskArn, warm.taskIp);
    // Replenish pool in the background (non-blocking)
    replenishWarmPool(logger).catch(() => {});
    return warm.taskIp;
  }

  // Cold start — launch a new task and wait for it to register
  logger.info('No warm tasks available, cold-starting new ECS task');
  const taskArn = await runAgentTask(logger);
  await assignTaskToSession(botId, groupJid, taskArn, '');

  const taskIp = await pollForTaskRegistration(taskArn, logger);
  // Update session with the resolved IP
  await assignTaskToSession(botId, groupJid, taskArn, taskIp);
  return taskIp;
}

/**
 * Check whether a task ARN corresponds to a running ECS task.
 */
export async function isTaskRunning(taskArn: string): Promise<boolean> {
  try {
    const res = await ecs.send(
      new DescribeTasksCommand({
        cluster: config.agentCluster,
        tasks: [taskArn],
      }),
    );
    const task = res.tasks?.[0];
    if (!task) return false;
    return task.lastStatus === 'RUNNING';
  } catch {
    return false;
  }
}

/**
 * Start the task manager background loops:
 * - Warm pool replenish every 30 seconds
 * - Idle session task scan every 10 minutes
 *
 * Guards: no-op if agent mode is not 'ecs' or if cluster/taskDef are not configured.
 */
export function startTaskManager(logger: Logger): void {
  if (config.agentMode !== 'ecs') return;

  if (!config.agentCluster || !config.agentTaskDefinition) {
    logger.warn(
      'ECS task manager: agentCluster or agentTaskDefinition not configured, skipping',
    );
    return;
  }

  logger.info(
    {
      cluster: config.agentCluster,
      taskDef: config.agentTaskDefinition,
      minWarm: config.minWarmTasks,
      idleTimeoutMin: config.idleTimeoutMinutes,
    },
    'Starting ECS task manager',
  );

  // Initial replenish
  replenishWarmPool(logger).catch((err) => {
    logger.error({ err }, 'Initial warm pool replenish failed');
  });

  replenishTimer = setInterval(() => {
    replenishWarmPool(logger).catch((err) => {
      logger.error({ err }, 'Warm pool replenish failed');
    });
  }, 30_000);

  idleScanTimer = setInterval(() => {
    scanAndStopIdleTasks(logger).catch((err) => {
      logger.error({ err }, 'Idle task scan failed');
    });
  }, 10 * 60_000);
}

/**
 * Stop the task manager background loops.
 */
export function stopTaskManager(): void {
  if (replenishTimer) {
    clearInterval(replenishTimer);
    replenishTimer = null;
  }
  if (idleScanTimer) {
    clearInterval(idleScanTimer);
    idleScanTimer = null;
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Launch a single ECS Fargate agent task.
 * Returns the task ARN.
 */
async function runAgentTask(logger: Logger): Promise<string> {
  const res = await ecs.send(
    new RunTaskCommand({
      cluster: config.agentCluster,
      taskDefinition: config.agentTaskDefinition,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: config.agentSubnets,
          securityGroups: [config.agentSecurityGroup],
          assignPublicIp: 'DISABLED',
        },
      },
      count: 1,
    }),
  );

  const task = res.tasks?.[0];
  if (!task?.taskArn) {
    const failures = res.failures?.map((f) => f.reason).join(', ') || 'unknown';
    throw new Error(`RunTask failed: ${failures}`);
  }

  logger.info({ taskArn: task.taskArn }, 'Started new ECS agent task');
  return task.taskArn;
}

/**
 * Replenish the warm pool to maintain `config.minWarmTasks` idle tasks.
 * Uses a DynamoDB distributed lock to prevent multiple control-plane replicas
 * from replenishing simultaneously (which would over-provision).
 * Lock TTL: 60s — if a replica crashes mid-replenish, the lock auto-expires.
 */
async function replenishWarmPool(logger: Logger): Promise<void> {
  const current = await countWarmTasks();
  const deficit = config.minWarmTasks - current;

  if (deficit <= 0) return;

  // Acquire distributed lock — only one replica replenishes at a time
  const lockOwner = await acquireReplenishLock(60);
  if (!lockOwner) {
    logger.debug('Warm pool replenish skipped — another replica holds the lock');
    return;
  }

  try {
    // Re-check after acquiring lock (another replica may have just finished)
    const recheck = await countWarmTasks();
    const actualDeficit = config.minWarmTasks - recheck;

    if (actualDeficit > 0) {
      logger.info(
        { current: recheck, target: config.minWarmTasks, deficit: actualDeficit },
        'Replenishing warm pool',
      );

      const launches = Array.from({ length: actualDeficit }, async () => {
        try {
          await runAgentTask(logger);
        } catch (err) {
          logger.error({ err }, 'Failed to launch warm pool task');
        }
      });

      await Promise.allSettled(launches);
    }
  } finally {
    await releaseReplenishLock(lockOwner).catch((err) => {
      logger.warn({ err }, 'Failed to release replenish lock — will expire via TTL');
    });
  }
}

/**
 * Poll DynamoDB for a warm task entry matching the given ARN.
 * The agent-runtime container registers itself (putWarmTask) once it boots
 * and passes health checks. We poll every 3 seconds for up to 90 seconds.
 */
async function pollForTaskRegistration(
  taskArn: string,
  logger: Logger,
): Promise<string> {
  const pollIntervalMs = 3_000;
  const maxWaitMs = 90_000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const record = await getWarmTaskByArn(taskArn);
    if (record?.taskIp) {
      logger.info(
        { taskArn, taskIp: record.taskIp },
        'Task registered successfully',
      );
      // Remove from warm pool since we are assigning it immediately
      await deleteWarmTask(taskArn);
      return record.taskIp;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Task ${taskArn} did not register within ${maxWaitMs / 1000}s`,
  );
}

/**
 * Scan for sessions whose dedicated task has been idle beyond the configured
 * timeout, verify the task is still running via ECS DescribeTasks, then stop
 * it and clear the session binding.
 */
async function scanAndStopIdleTasks(logger: Logger): Promise<void> {
  const idleSessions = await scanIdleSessionTasks(config.idleTimeoutMinutes);

  if (idleSessions.length === 0) return;

  logger.info(
    { count: idleSessions.length },
    'Found idle session tasks to reclaim',
  );

  for (const session of idleSessions) {
    try {
      // Verify the task is actually still running before trying to stop it
      const running = await isTaskRunning(session.taskArn);
      if (running) {
        await ecs.send(
          new StopTaskCommand({
            cluster: config.agentCluster,
            task: session.taskArn,
            reason: 'Idle timeout exceeded',
          }),
        );
        logger.info(
          { taskArn: session.taskArn, botId: session.botId, groupJid: session.groupJid },
          'Stopped idle task',
        );
      }

      await clearSessionTask(session.botId, session.groupJid);
    } catch (err) {
      logger.error(
        { err, taskArn: session.taskArn },
        'Failed to stop idle task',
      );
    }
  }
}
