// ClawBot Cloud — ECS Task Manager
// Manages warm pool of pre-started Fargate tasks and per-session task assignment.
// Warm tasks are idle containers ready for instant dispatch; when a session needs
// a task we claim from the pool first, falling back to cold-start RunTask + poll.

import {
  ECSClient,
  RunTaskCommand,
  ListTasksCommand,
  DescribeTasksCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import { config } from '../config.js';
import {
  countWarmTasks,
  listWarmTaskArns,
  deleteWarmTask,
  claimWarmTask,
  getWarmTaskByArn,
  assignTaskToSession,
  clearSessionTask,
  scanIdleSessionTasks,
  scanAllSessionTasks,
  acquireReplenishLock,
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
  // Attempt warm claim — loop to skip stale warm tasks whose ECS task has stopped
  // between replenish cycles (up to 3 attempts before falling through to cold start).
  for (let attempt = 0; attempt < 3; attempt++) {
    const warm = await claimWarmTask();
    if (!warm) break; // Pool empty — fall through to cold start

    // Verify the ECS task is actually alive before using it
    const alive = await isTaskRunning(warm.taskArn);
    if (!alive) {
      logger.warn(
        { taskArn: warm.taskArn, taskIp: warm.taskIp, attempt },
        'Claimed warm task is stale (ECS task stopped), retrying',
      );
      continue; // claimWarmTask already deleted the record; try next
    }

    logger.info(
      { taskArn: warm.taskArn, taskIp: warm.taskIp },
      'Claimed warm task for session',
    );
    await assignTaskToSession(botId, groupJid, warm.taskArn, warm.taskIp);
    // Replenish pool in the background (non-blocking)
    replenishWarmPool(logger).catch(() => {});
    return warm.taskIp;
  }

  // No warm task — check maxTasks before cold-starting
  const currentCount = await countClusterTasks(logger);
  if (currentCount >= config.maxTasks) {
    throw new Error(`Max tasks limit reached (${currentCount}/${config.maxTasks}), cannot start new task`);
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

  // Initial replenish (delayed 5s to let other replica start first if simultaneous)
  setTimeout(() => {
    replenishWarmPool(logger).catch((err) => {
      logger.error({ err }, 'Initial warm pool replenish failed');
    });
  }, 5_000 + Math.floor(Math.random() * 5_000));

  // Check warm pool every 3 minutes (must be > lock TTL of 120s to avoid
  // re-triggering while launched tasks are still booting)
  replenishTimer = setInterval(() => {
    replenishWarmPool(logger).catch((err) => {
      logger.error({ err }, 'Warm pool replenish failed');
    });
  }, 3 * 60_000);

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

/** Count running tasks in the agent ECS cluster (paginated). */
async function countClusterTasks(logger: Logger): Promise<number> {
  try {
    let count = 0;
    let nextToken: string | undefined;
    do {
      const res = await ecs.send(
        new ListTasksCommand({
          cluster: config.agentCluster,
          desiredStatus: 'RUNNING',
          ...(nextToken && { nextToken }),
        }),
      );
      count += res.taskArns?.length ?? 0;
      nextToken = res.nextToken;
    } while (nextToken);
    return count;
  } catch (err) {
    logger.warn({ err }, 'Failed to count cluster tasks, assuming 0');
    return 0;
  }
}

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

/** Statuses that indicate a task is alive (booting or running). */
const ALIVE_STATUSES = new Set(['PROVISIONING', 'PENDING', 'ACTIVATING', 'RUNNING']);

/** DescribeTasks accepts at most 100 ARNs per call. */
const DESCRIBE_BATCH_SIZE = 100;

/**
 * Call DescribeTasks in batches of 100, return the set of alive task ARNs.
 */
async function batchDescribeAliveArns(arns: string[]): Promise<Set<string>> {
  const alive = new Set<string>();
  for (let i = 0; i < arns.length; i += DESCRIBE_BATCH_SIZE) {
    const batch = arns.slice(i, i + DESCRIBE_BATCH_SIZE);
    const res = await ecs.send(
      new DescribeTasksCommand({ cluster: config.agentCluster, tasks: batch }),
    );
    for (const t of res.tasks ?? []) {
      if (ALIVE_STATUSES.has(t.lastStatus ?? '')) alive.add(t.taskArn!);
    }
  }
  return alive;
}

/**
 * Verify warm task DynamoDB records against ECS — delete entries whose
 * underlying ECS task is no longer alive (RUNNING/PENDING/PROVISIONING).
 */
async function evictStaleWarmTasks(logger: Logger): Promise<void> {
  const arns = await listWarmTaskArns();
  if (arns.length === 0) return;

  try {
    const aliveArns = await batchDescribeAliveArns(arns);
    const staleArns = arns.filter((a) => !aliveArns.has(a));

    for (const arn of staleArns) {
      await deleteWarmTask(arn);
      logger.info({ taskArn: arn }, 'Evicted stale warm task record');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to validate warm pool tasks');
  }
}

/**
 * Verify session-bound task records against ECS — clear bindings whose
 * underlying ECS task is no longer alive. This catches "ghost" sessions
 * left behind when tasks stop without updating DynamoDB (e.g. forced stops,
 * OOM kills, or network partitions during shutdown).
 */
async function evictStaleSessionTasks(logger: Logger): Promise<void> {
  const sessions = await scanAllSessionTasks();
  if (sessions.length === 0) return;

  const arns = sessions.map((s) => s.taskArn);

  try {
    const aliveArns = await batchDescribeAliveArns(arns);

    for (const session of sessions) {
      if (!aliveArns.has(session.taskArn)) {
        await clearSessionTask(session.botId, session.groupJid);
        logger.info(
          { botId: session.botId, groupJid: session.groupJid, taskArn: session.taskArn },
          'Cleared stale session task binding',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to validate session tasks');
  }
}

/**
 * Replenish the warm pool to maintain `config.minWarmTasks` idle tasks.
 * Uses a DynamoDB distributed lock with a 120s TTL. The lock is NOT released
 * after launching — it stays held until TTL expires, giving launched tasks
 * time to boot and register in DynamoDB (~30-90s). This prevents other
 * replicas (or the next interval tick) from seeing 0 registered tasks and
 * over-provisioning.
 */
async function replenishWarmPool(logger: Logger): Promise<void> {
  // Quick check: if warm count already meets target, still need to validate.
  // Stale records can inflate count, so always evict before making decisions.
  // Acquire lock first to avoid duplicate DescribeTasks calls across replicas.
  const lockOwner = await acquireReplenishLock(120);
  if (!lockOwner) {
    logger.debug('Warm pool replenish skipped — lock held (tasks may be booting)');
    return;
  }

  // Evict ghost warm records under lock — avoids evicting tasks that are still
  // booting from a concurrent replenish (lock guarantees single-writer).
  await evictStaleWarmTasks(logger);
  const validatedCount = await countWarmTasks();

  const actualDeficit = config.minWarmTasks - validatedCount;
  if (actualDeficit <= 0) return;

  logger.info(
    { warmCount: validatedCount, target: config.minWarmTasks, deficit: actualDeficit },
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
  // Lock stays held — auto-expires after 120s via DynamoDB TTL condition
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
 * it and clear the session binding. Also evicts stale session/warm records
 * whose ECS tasks have already stopped.
 */
async function scanAndStopIdleTasks(logger: Logger): Promise<void> {
  // Evict ghost session records (tasks stopped without DynamoDB cleanup).
  // Warm pool eviction is handled by replenishWarmPool (every 3 min).
  await evictStaleSessionTasks(logger);

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
