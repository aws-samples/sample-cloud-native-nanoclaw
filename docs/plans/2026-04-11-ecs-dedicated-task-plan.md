# ECS Dedicated Task per Session — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace ECS shared service pool with per-session dedicated tasks where each `botId#groupJid` gets its own ECS task, routed via DynamoDB registry with warm pool for instant dispatch.

**Architecture:** Control-plane runs `ecs:RunTask` for new sessions, routes via DynamoDB task registry (taskIp), maintains a warm pool (minWarmTasks). Tasks self-stop after idle timeout; control-plane scans as safety net. AgentCore mode unaffected.

**Tech Stack:** AWS ECS (RunTask API), DynamoDB (task registry), ECS Task Metadata Endpoint v4, Fastify, TypeScript ESM, AWS CDK.

**Design doc:** `docs/plans/2026-04-11-ecs-dedicated-task-design.md`

---

## Task 1: Extend Session type with task registry fields

**Files:**
- Modify: `shared/src/types.ts:201-212`

**Step 1: Add task registry fields to Session interface**

In `shared/src/types.ts`, find the `Session` interface (line 201) and add after `lastModelProvider`:

```typescript
export interface Session {
  botId: string;
  groupJid: string;
  agentcoreSessionId: string;
  s3SessionPath: string;
  lastActiveAt: string;
  status: 'active' | 'idle' | 'terminated';
  lastModel?: string;
  lastModelProvider?: ModelProvider;
  // ECS dedicated task registry (ecs mode only)
  taskArn?: string;
  taskIp?: string;
  taskStatus?: 'warm' | 'running' | 'stopping' | 'stopped';
  lastInvocationAt?: string;
}
```

**Step 2: Verify typecheck passes**

Run: `npm run typecheck -w shared`
Expected: PASS (new optional fields don't break existing code)

**Step 3: Build shared package**

Run: `npm run build -w shared`
Expected: PASS

**Step 4: Commit**

```bash
git add shared/src/types.ts
git commit -m "feat(shared): add task registry fields to Session type"
```

---

## Task 2: Add DynamoDB warm task + session task CRUD functions

**Files:**
- Modify: `control-plane/src/services/dynamo.ts`

**Step 1: Add warm task DynamoDB functions**

Add these functions after the existing `putSession` function (around line 977):

```typescript
// ── ECS Dedicated Task Registry ──────────────────────────────────────────

/** Store a warm task record. PK = "warm", SK = taskArn */
export async function putWarmTask(taskArn: string, taskIp: string): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: config.tables.sessions,
      Item: {
        pk: 'warm',
        sk: taskArn,
        taskArn,
        taskIp,
        taskStatus: 'warm',
        startedAt: new Date().toISOString(),
      },
    }),
  );
}

/**
 * Atomically claim one warm task. Returns the task or null if none available.
 * Uses ConditionExpression to prevent double-claiming across replicas.
 */
export async function claimWarmTask(): Promise<{ taskArn: string; taskIp: string } | null> {
  // First, query for any warm task
  const result = await client.send(
    new QueryCommand({
      TableName: config.tables.sessions,
      KeyConditionExpression: 'pk = :pk',
      FilterExpression: 'taskStatus = :warm',
      ExpressionAttributeValues: { ':pk': 'warm', ':warm': 'warm' },
      Limit: 1,
    }),
  );
  if (!result.Items || result.Items.length === 0) return null;

  const task = result.Items[0] as { sk: string; taskArn: string; taskIp: string };

  // Atomically claim it (delete with condition to prevent race)
  try {
    await client.send(
      new DeleteCommand({
        TableName: config.tables.sessions,
        Key: { pk: 'warm', sk: task.sk },
        ConditionExpression: 'taskStatus = :warm',
        ExpressionAttributeValues: { ':warm': 'warm' },
      }),
    );
    return { taskArn: task.taskArn, taskIp: task.taskIp };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return null; // Another replica claimed it
    }
    throw err;
  }
}

/** Count warm tasks currently available. */
export async function countWarmTasks(): Promise<number> {
  const result = await client.send(
    new QueryCommand({
      TableName: config.tables.sessions,
      KeyConditionExpression: 'pk = :pk',
      FilterExpression: 'taskStatus = :warm',
      ExpressionAttributeValues: { ':pk': 'warm', ':warm': 'warm' },
      Select: 'COUNT',
    }),
  );
  return result.Count ?? 0;
}

/** Delete a warm task record (task was assigned or stopped). */
export async function deleteWarmTask(taskArn: string): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: config.tables.sessions,
      Key: { pk: 'warm', sk: taskArn },
    }),
  );
}

/** Update session with task assignment fields. */
export async function assignTaskToSession(
  botId: string,
  groupJid: string,
  taskArn: string,
  taskIp: string,
): Promise<void> {
  const pk = `${botId}#${groupJid}`;
  await client.send(
    new UpdateCommand({
      TableName: config.tables.sessions,
      Key: { pk, sk: 'current' },
      UpdateExpression: 'SET taskArn = :arn, taskIp = :ip, taskStatus = :status, lastInvocationAt = :now',
      ExpressionAttributeValues: {
        ':arn': taskArn,
        ':ip': taskIp,
        ':status': 'running',
        ':now': new Date().toISOString(),
      },
    }),
  );
}

/** Update lastInvocationAt timestamp for an existing session task. */
export async function touchSessionTask(botId: string, groupJid: string): Promise<void> {
  const pk = `${botId}#${groupJid}`;
  await client.send(
    new UpdateCommand({
      TableName: config.tables.sessions,
      Key: { pk, sk: 'current' },
      UpdateExpression: 'SET lastInvocationAt = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }),
  );
}

/** Clear task fields from session (task stopped/crashed). */
export async function clearSessionTask(botId: string, groupJid: string): Promise<void> {
  const pk = `${botId}#${groupJid}`;
  await client.send(
    new UpdateCommand({
      TableName: config.tables.sessions,
      Key: { pk, sk: 'current' },
      UpdateExpression: 'SET taskStatus = :stopped REMOVE taskArn, taskIp',
      ExpressionAttributeValues: { ':stopped': 'stopped' },
    }),
  );
}

/** Scan sessions with running tasks that have been idle too long. */
export async function scanIdleSessionTasks(idleMinutes: number): Promise<Array<{
  botId: string; groupJid: string; taskArn: string; lastInvocationAt: string;
}>> {
  const cutoff = new Date(Date.now() - idleMinutes * 60 * 1000).toISOString();
  const result = await client.send(
    new ScanCommand({
      TableName: config.tables.sessions,
      FilterExpression: 'taskStatus = :running AND lastInvocationAt < :cutoff AND sk = :sk',
      ExpressionAttributeValues: {
        ':running': 'running',
        ':cutoff': cutoff,
        ':sk': 'current',
      },
    }),
  );
  return (result.Items ?? []).map((item) => ({
    botId: item.botId as string,
    groupJid: item.groupJid as string,
    taskArn: item.taskArn as string,
    lastInvocationAt: item.lastInvocationAt as string,
  }));
}
```

**Step 2: Add missing imports if needed**

Ensure `QueryCommand`, `DeleteCommand`, `ScanCommand` are imported from `@aws-sdk/lib-dynamodb`. Check existing imports at top of file — most should already be there.

**Step 3: Verify typecheck**

Run: `npm run typecheck -w control-plane`
Expected: PASS

**Step 4: Commit**

```bash
git add control-plane/src/services/dynamo.ts
git commit -m "feat(control-plane): add warm task + session task DynamoDB functions"
```

---

## Task 3: Add config fields for ECS dedicated task mode

**Files:**
- Modify: `control-plane/src/config.ts`

**Step 1: Add new config fields**

Add after the `maxConcurrentDispatches` line (~line 88):

```typescript
  // ECS dedicated task mode (ecs mode only)
  agentCluster: process.env.AGENT_CLUSTER || '',
  agentTaskDefinition: process.env.AGENT_TASK_DEFINITION || '',
  agentSubnets: (process.env.AGENT_SUBNETS || '').split(',').filter(Boolean),
  agentSecurityGroup: process.env.AGENT_SECURITY_GROUP || '',
  minWarmTasks: Number(process.env.MIN_WARM_TASKS) || 2,
  idleTimeoutMinutes: Number(process.env.IDLE_TIMEOUT_MINUTES) || 60,
```

**Step 2: Verify typecheck**

Run: `npm run typecheck -w control-plane`
Expected: PASS

**Step 3: Commit**

```bash
git add control-plane/src/config.ts
git commit -m "feat(control-plane): add ECS dedicated task config fields"
```

---

## Task 4: Create task-manager.ts (warm pool + RunTask + idle scan)

**Files:**
- Create: `control-plane/src/sqs/task-manager.ts`

**Step 1: Create the task manager module**

```typescript
// ECS Dedicated Task Manager — Warm pool maintenance, RunTask, StopTask, idle scan
// Only active in ECS mode (config.agentMode === 'ecs')

import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
} from '@aws-sdk/client-ecs';
import { config } from '../config.js';
import {
  putWarmTask,
  countWarmTasks,
  deleteWarmTask,
  claimWarmTask,
  assignTaskToSession,
  touchSessionTask,
  clearSessionTask,
  scanIdleSessionTasks,
} from '../services/dynamo.js';
import type { Logger } from 'pino';

const ecs = new ECSClient({ region: config.region });

let managerLogger: Logger | null = null;
let warmPoolInterval: ReturnType<typeof setInterval> | null = null;
let idleScanInterval: ReturnType<typeof setInterval> | null = null;

// ── Warm Pool ────────────────────────────────────────────────────────────

/** Start a new ECS task (returns taskArn). Task will self-register in DynamoDB. */
async function runAgentTask(logger: Logger): Promise<string> {
  const result = await ecs.send(
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

  const task = result.tasks?.[0];
  if (!task?.taskArn) {
    throw new Error('RunTask returned no task ARN');
  }

  logger.info({ taskArn: task.taskArn }, 'Started new agent task');
  return task.taskArn;
}

/** Ensure warm pool has at least minWarmTasks available. */
async function replenishWarmPool(logger: Logger): Promise<void> {
  const count = await countWarmTasks();
  const deficit = config.minWarmTasks - count;

  if (deficit <= 0) return;

  logger.info({ current: count, target: config.minWarmTasks, starting: deficit }, 'Replenishing warm pool');

  // Start tasks in parallel
  const promises = Array.from({ length: deficit }, () =>
    runAgentTask(logger).catch((err) => {
      logger.error({ err }, 'Failed to start warm task');
    }),
  );
  await Promise.all(promises);
}

// ── Task Assignment ──────────────────────────────────────────────────────

/**
 * Assign a task to a session. Tries warm pool first, falls back to RunTask.
 * Returns the task's private IP for direct HTTP dispatch.
 */
export async function assignTaskForSession(
  botId: string,
  groupJid: string,
  logger: Logger,
): Promise<string> {
  // 1. Try claiming a warm task
  const warmTask = await claimWarmTask();
  if (warmTask) {
    logger.info({ taskArn: warmTask.taskArn, botId, groupJid }, 'Claimed warm task for session');
    await assignTaskToSession(botId, groupJid, warmTask.taskArn, warmTask.taskIp);
    // Replenish warm pool async (don't block dispatch)
    replenishWarmPool(logger).catch(() => {});
    return warmTask.taskIp;
  }

  // 2. No warm task — cold start: RunTask and poll for registration
  logger.info({ botId, groupJid }, 'No warm task available, starting new task (cold start)');
  const taskArn = await runAgentTask(logger);

  // Poll DynamoDB until the task registers itself with its IP
  const taskIp = await pollForTaskRegistration(taskArn, logger);
  await assignTaskToSession(botId, groupJid, taskArn, taskIp);

  // Replenish warm pool async
  replenishWarmPool(logger).catch(() => {});
  return taskIp;
}

/** Poll DynamoDB warm task records until the new task registers. Max ~90s. */
async function pollForTaskRegistration(taskArn: string, logger: Logger): Promise<string> {
  const maxAttempts = 30; // 30 * 3s = 90s
  const pollInterval = 3_000;

  for (let i = 0; i < maxAttempts; i++) {
    // Check if task registered as warm
    const count = await countWarmTasks(); // Simple check — could optimize with GetItem
    // Actually, let's query for this specific taskArn
    const { DynamoDBDocumentClient, GetCommand } = await import('@aws-sdk/lib-dynamodb');
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const rawClient = new DynamoDBClient({ region: config.region });
    const client = DynamoDBDocumentClient.from(rawClient);

    const result = await client.send(
      new GetCommand({
        TableName: config.tables.sessions,
        Key: { pk: 'warm', sk: taskArn },
      }),
    );

    if (result.Item?.taskIp) {
      return result.Item.taskIp as string;
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new Error(`Task ${taskArn} did not register within 90s`);
}

// ── Task Verification ────────────────────────────────────────────────────

/** Check if an ECS task is still running. Returns false if stopped/missing. */
export async function isTaskRunning(taskArn: string): Promise<boolean> {
  try {
    const result = await ecs.send(
      new DescribeTasksCommand({
        cluster: config.agentCluster,
        tasks: [taskArn],
      }),
    );
    const task = result.tasks?.[0];
    return task?.lastStatus === 'RUNNING';
  } catch {
    return false;
  }
}

// ── Idle Task Scanner (safety net) ───────────────────────────────────────

async function scanAndStopIdleTasks(logger: Logger): Promise<void> {
  try {
    const idleSessions = await scanIdleSessionTasks(config.idleTimeoutMinutes);
    if (idleSessions.length === 0) return;

    logger.info({ count: idleSessions.length }, 'Found idle session tasks');

    for (const session of idleSessions) {
      try {
        // Verify task is actually running before stopping
        const running = await isTaskRunning(session.taskArn);
        if (running) {
          await ecs.send(
            new StopTaskCommand({
              cluster: config.agentCluster,
              task: session.taskArn,
              reason: 'Idle timeout exceeded',
            }),
          );
          logger.info({ taskArn: session.taskArn, botId: session.botId }, 'Stopped idle task');
        }
        await clearSessionTask(session.botId, session.groupJid);
      } catch (err) {
        logger.error({ err, taskArn: session.taskArn }, 'Failed to stop idle task');
      }
    }
  } catch (err) {
    logger.error({ err }, 'Idle task scan failed');
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────

export function startTaskManager(logger: Logger): void {
  if (config.agentMode !== 'ecs') return;
  if (!config.agentCluster || !config.agentTaskDefinition) {
    logger.warn('AGENT_CLUSTER or AGENT_TASK_DEFINITION not set, task manager disabled');
    return;
  }

  managerLogger = logger;
  logger.info(
    { cluster: config.agentCluster, minWarmTasks: config.minWarmTasks, idleTimeoutMinutes: config.idleTimeoutMinutes },
    'Task manager started',
  );

  // Initial warm pool fill
  replenishWarmPool(logger).catch((err) =>
    logger.error({ err }, 'Initial warm pool fill failed'),
  );

  // Periodic warm pool check (every 30s)
  warmPoolInterval = setInterval(() => {
    replenishWarmPool(logger).catch((err) =>
      logger.error({ err }, 'Warm pool replenish failed'),
    );
  }, 30_000);

  // Periodic idle task scan (every 10 min)
  idleScanInterval = setInterval(() => {
    scanAndStopIdleTasks(logger).catch((err) =>
      logger.error({ err }, 'Idle task scan error'),
    );
  }, 10 * 60 * 1000);
}

export function stopTaskManager(): void {
  if (warmPoolInterval) { clearInterval(warmPoolInterval); warmPoolInterval = null; }
  if (idleScanInterval) { clearInterval(idleScanInterval); idleScanInterval = null; }
}
```

**Step 2: Fix pollForTaskRegistration — use shared DynamoDB client**

The `pollForTaskRegistration` function above has inline imports. Refactor to use the existing DynamoDB client pattern. Add a `getWarmTaskByArn` function to `dynamo.ts`:

```typescript
// In dynamo.ts
export async function getWarmTaskByArn(taskArn: string): Promise<{ taskIp: string } | null> {
  const result = await client.send(
    new GetCommand({
      TableName: config.tables.sessions,
      Key: { pk: 'warm', sk: taskArn },
    }),
  );
  return result.Item ? { taskIp: result.Item.taskIp as string } : null;
}
```

Then update `pollForTaskRegistration` in `task-manager.ts`:

```typescript
import { ..., getWarmTaskByArn } from '../services/dynamo.js';

async function pollForTaskRegistration(taskArn: string, logger: Logger): Promise<string> {
  const maxAttempts = 30;
  const pollInterval = 3_000;

  for (let i = 0; i < maxAttempts; i++) {
    const task = await getWarmTaskByArn(taskArn);
    if (task?.taskIp) return task.taskIp;
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new Error(`Task ${taskArn} did not register within 90s`);
}
```

**Step 3: Verify typecheck**

Run: `npm run typecheck -w control-plane`
Expected: PASS

**Step 4: Commit**

```bash
git add control-plane/src/sqs/task-manager.ts control-plane/src/services/dynamo.ts
git commit -m "feat(control-plane): add ECS task manager with warm pool"
```

---

## Task 5: Replace EcsHttpInvoker with EcsTaskInvoker

**Files:**
- Modify: `control-plane/src/sqs/dispatcher.ts`

**Step 1: Remove old ECS code, add new EcsTaskInvoker**

Remove:
- `AgentBusyError` class (lines 586-591)
- `EcsHttpInvoker` class (lines 634-713)
- `import { isConsumerRunning } from './consumer.js'` (line 48)

Add import at top:

```typescript
import { assignTaskForSession, isTaskRunning } from './task-manager.js';
import { getSession, touchSessionTask, clearSessionTask } from '../services/dynamo.js';
```

Note: `getSession` is already imported. Add the other two to the existing import.

Replace `EcsHttpInvoker` with:

```typescript
class EcsTaskInvoker implements AgentInvoker {
  private static readonly NETWORK_MAX_RETRIES = 3;
  private static readonly NETWORK_RETRY_DELAY_MS = 5_000;

  async invoke(payload: InvocationPayload, logger: Logger): Promise<InvocationResult> {
    // 1. Look up existing task for this session
    const session = await getSession(payload.botId, payload.groupJid);

    if (session?.taskStatus === 'running' && session.taskIp) {
      // 2a. Try dispatch to existing task
      const result = await this.httpInvoke(session.taskIp, payload, logger);
      if (result) {
        await touchSessionTask(payload.botId, payload.groupJid);
        return result;
      }
      // Task gone — clear stale record and reassign
      logger.warn({ taskArn: session.taskArn, botId: payload.botId }, 'Task unreachable, reassigning');
      await clearSessionTask(payload.botId, payload.groupJid);
    }

    // 2b. Assign a new task (warm pool or cold start)
    const taskIp = await assignTaskForSession(payload.botId, payload.groupJid, logger);

    // 3. Dispatch to newly assigned task
    const result = await this.httpInvoke(taskIp, payload, logger);
    if (!result) {
      return { status: 'error', result: null, error: 'Failed to dispatch to newly assigned task' };
    }
    await touchSessionTask(payload.botId, payload.groupJid);
    return result;
  }

  /** HTTP POST to task. Returns null if task is unreachable (for reassignment). */
  private async httpInvoke(
    taskIp: string,
    payload: InvocationPayload,
    logger: Logger,
  ): Promise<InvocationResult | null> {
    const url = `http://${taskIp}:8080/invocations`;

    for (let attempt = 0; attempt < EcsTaskInvoker.NETWORK_MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
          const text = await res.text();
          logger.error({ status: res.status, body: text }, 'Agent task returned error');
          return { status: 'error', result: null, error: `Agent task returned ${res.status}: ${text}` };
        }

        return { status: 'accepted', result: null };
      } catch (err: unknown) {
        if (attempt < EcsTaskInvoker.NETWORK_MAX_RETRIES - 1) {
          logger.warn({ err, attempt: attempt + 1, taskIp }, 'Agent task network error, retrying');
          await new Promise((r) => setTimeout(r, EcsTaskInvoker.NETWORK_RETRY_DELAY_MS));
          continue;
        }
        logger.error({ err, taskIp }, 'Agent task unreachable after retries');
        return null; // Signal to caller: task is gone, reassign
      }
    }
    return null;
  }
}
```

Update `createInvoker()`:

```typescript
function createInvoker(): AgentInvoker {
  if (config.agentMode === 'ecs') return new EcsTaskInvoker();
  return new AgentCoreInvoker();
}
```

**Step 2: Verify typecheck**

Run: `npm run typecheck -w control-plane`
Expected: PASS

**Step 3: Commit**

```bash
git add control-plane/src/sqs/dispatcher.ts
git commit -m "feat(control-plane): replace EcsHttpInvoker with EcsTaskInvoker"
```

---

## Task 6: Simplify consumer.ts — remove ECS-specific metric/retry code

**Files:**
- Modify: `control-plane/src/sqs/consumer.ts`

**Step 1: Remove ECS-specific code**

Remove these imports and code:
- `CloudWatchClient`, `PutMetricDataCommand` imports
- `AgentBusyError` import from dispatcher
- `isConsumerRunning` export function
- `dispatchingGroups` Set
- `metricsInterval` variable
- `publishActiveGroupsMetric()` function
- CloudWatch client `cw`
- `metricsInterval` logic in `startSqsConsumer` and `stopSqsConsumer`
- `publishActiveGroupsMetric()` calls
- `AgentBusyError` catch block in dispatch handler — replace with simple error logging

The dispatch `.then/.catch/.finally` chain becomes simpler:

```typescript
        dispatch(msg, logger)
          .then(() => {
            if (groupKey) {
              setPendingDelete(groupKey, handle);
              logger.debug({ key: groupKey, messageId: msg.MessageId }, 'Deferred SQS delete until agent reply');
            } else {
              sqs.send(new DeleteMessageCommand({
                QueueUrl: config.queues.messages,
                ReceiptHandle: handle,
              })).catch(() => {});
            }
          })
          .catch((err) => {
            logger.error(
              { err, messageId: msg.MessageId },
              'Dispatch failed, message will return to queue after visibility timeout',
            );
          })
          .finally(() => {
            inFlightHandles.delete(handle);
            semaphore.release();
            if (!running && inFlightHandles.size === 0 && drainResolve) {
              drainResolve();
            }
          });
```

Remove `groupKey` tracking for `dispatchingGroups` (keep only for `setPendingDelete`):

```typescript
        let groupKey: string | null = null;
        try {
          const body = JSON.parse(msg.Body!) as SqsPayload;
          groupKey = `${body.botId}#${body.groupJid}`;
        } catch { /* parse error handled in .then */ }
```

**Step 2: Verify typecheck**

Run: `npm run typecheck -w control-plane`
Expected: PASS

**Step 3: Commit**

```bash
git add control-plane/src/sqs/consumer.ts
git commit -m "refactor(control-plane): remove ECS metric/retry code from consumer"
```

---

## Task 7: Initialize task manager in control-plane startup

**Files:**
- Modify: `control-plane/src/index.ts`

**Step 1: Add task manager startup and shutdown**

Add import:

```typescript
import { startTaskManager, stopTaskManager } from './sqs/task-manager.js';
```

After the existing `startSqsConsumer(logger)` call (around line 92), add:

```typescript
startTaskManager(logger);
```

In the shutdown handler, add before `stopSqsConsumer()`:

```typescript
stopTaskManager();
```

**Step 2: Verify typecheck**

Run: `npm run typecheck -w control-plane`
Expected: PASS

**Step 3: Commit**

```bash
git add control-plane/src/index.ts
git commit -m "feat(control-plane): initialize task manager on startup"
```

---

## Task 8: Create agent-runtime task registration module

**Files:**
- Create: `agent-runtime/src/task-registration.ts`

**Step 1: Create task registration module**

```typescript
// ECS Task Registration — registers this task in DynamoDB on startup
// Fetches taskArn and privateIp from ECS Task Metadata Endpoint v4

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Logger } from 'pino';

const METADATA_URI = process.env.ECS_CONTAINER_METADATA_URI_V4;

interface TaskMetadata {
  taskArn: string;
  privateIp: string;
}

/** Fetch task ARN and private IP from ECS Task Metadata Endpoint v4. */
async function getTaskMetadata(): Promise<TaskMetadata> {
  if (!METADATA_URI) {
    throw new Error('ECS_CONTAINER_METADATA_URI_V4 not set — not running in ECS?');
  }

  // Task-level metadata
  const taskRes = await fetch(`${METADATA_URI}/task`);
  const taskMeta = await taskRes.json() as { TaskARN: string; Containers: Array<{ Networks: Array<{ IPv4Addresses: string[] }> }> };

  const taskArn = taskMeta.TaskARN;
  const privateIp = taskMeta.Containers?.[0]?.Networks?.[0]?.IPv4Addresses?.[0];

  if (!taskArn || !privateIp) {
    throw new Error(`Failed to get task metadata: taskArn=${taskArn}, privateIp=${privateIp}`);
  }

  return { taskArn, privateIp };
}

/** Register this task as a warm task in DynamoDB sessions table. */
export async function registerTask(logger: Logger): Promise<TaskMetadata> {
  const meta = await getTaskMetadata();

  const sessionsTable = process.env.SESSIONS_TABLE || 'nanoclawbot-dev-sessions';
  const region = process.env.AWS_REGION || 'us-east-1';

  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region }),
    { marshallOptions: { removeUndefinedValues: true } },
  );

  await client.send(
    new PutCommand({
      TableName: sessionsTable,
      Item: {
        pk: 'warm',
        sk: meta.taskArn,
        taskArn: meta.taskArn,
        taskIp: meta.privateIp,
        taskStatus: 'warm',
        startedAt: new Date().toISOString(),
      },
    }),
  );

  logger.info({ taskArn: meta.taskArn, privateIp: meta.privateIp }, 'Task registered as warm');
  return meta;
}
```

**Step 2: Verify typecheck**

Run: `npm run typecheck -w agent-runtime`
Expected: PASS

**Step 3: Commit**

```bash
git add agent-runtime/src/task-registration.ts
git commit -m "feat(agent-runtime): add ECS task registration module"
```

---

## Task 9: Create agent-runtime idle monitor module

**Files:**
- Create: `agent-runtime/src/idle-monitor.ts`

**Step 1: Create idle monitor module**

```typescript
// Idle Monitor — tracks time since last invocation, exits after timeout
// Used in ECS dedicated task mode only

import type { Logger } from 'pino';

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let monitorLogger: Logger | null = null;
let timeoutMs: number;
let onTimeout: (() => Promise<void>) | null = null;

/** Start the idle monitor. Calls `onTimeoutFn` when idle timeout expires. */
export function startIdleMonitor(
  logger: Logger,
  idleTimeoutMinutes: number,
  onTimeoutFn: () => Promise<void>,
): void {
  monitorLogger = logger;
  timeoutMs = idleTimeoutMinutes * 60 * 1000;
  onTimeout = onTimeoutFn;
  resetIdleTimer();
  logger.info({ idleTimeoutMinutes }, 'Idle monitor started');
}

/** Reset the idle timer (call on each invocation). */
export function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    monitorLogger?.info('Idle timeout reached, shutting down');
    if (onTimeout) {
      await onTimeout().catch((err) => {
        monitorLogger?.error({ err }, 'Error during idle shutdown');
      });
    }
    process.exit(0);
  }, timeoutMs);
  // Don't let the timer keep the process alive if everything else is done
  idleTimer.unref();
}

/** Stop the idle monitor (e.g., during graceful shutdown). */
export function stopIdleMonitor(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}
```

**Step 2: Verify typecheck**

Run: `npm run typecheck -w agent-runtime`
Expected: PASS

**Step 3: Commit**

```bash
git add agent-runtime/src/idle-monitor.ts
git commit -m "feat(agent-runtime): add idle monitor for ECS dedicated tasks"
```

---

## Task 10: Update agent-runtime server.ts — integrate registration + idle monitor

**Files:**
- Modify: `agent-runtime/src/server.ts`

**Step 1: Add conditional ECS task registration and idle monitoring**

Add imports:

```typescript
import { registerTask } from './task-registration.js';
import { startIdleMonitor, resetIdleTimer } from './idle-monitor.js';
```

Remove the `busy` flag for ECS mode. The `/invocations` endpoint should still accept requests (no 503), but the `busy` flag is only used for `/ping` status now (keep it for health reporting).

In the `/invocations` handler, add `resetIdleTimer()` call and remove 503 rejection for ECS mode:

```typescript
app.post<{ Body: InvocationPayload }>('/invocations', async (request, reply) => {
  const payload = request.body;
  const isEcsMode = process.env.AGENT_MODE === 'ecs';

  // In shared service mode, reject concurrent requests (single-concurrency per task)
  // In dedicated task mode, no rejection needed (task is dedicated to this session)
  if (!isEcsMode && busy) {
    logger.info({ botId: payload.botId, groupJid: payload.groupJid }, 'Agent busy, rejecting request');
    return reply.status(503).send({ error: 'Agent is busy' });
  }

  logger.info({ botId: payload.botId, groupJid: payload.groupJid }, 'Invocation received');
  setBusy();

  // Reset idle timer on each invocation (ECS dedicated mode)
  if (isEcsMode) resetIdleTimer();

  runInBackground(payload).catch((err) => {
    logger.error(err, 'Background invocation crashed unexpectedly');
  });

  return reply.send({ status: 'accepted' });
});
```

Add startup registration before `app.listen()`:

```typescript
// ECS dedicated task mode — register in DynamoDB and start idle monitor
if (process.env.AGENT_MODE === 'ecs') {
  try {
    const meta = await registerTask(logger);
    logger.info({ taskArn: meta.taskArn }, 'ECS task registered');

    const idleMinutes = Number(process.env.IDLE_TIMEOUT_MINUTES) || 60;
    startIdleMonitor(logger, idleMinutes, async () => {
      // Graceful shutdown: sync any remaining state to S3
      logger.info('Idle timeout — performing graceful shutdown');
      // DynamoDB cleanup will be done by control-plane safety net scan
    });
  } catch (err) {
    logger.error(err, 'Failed to register ECS task');
    // Continue anyway — task can still serve requests via direct IP
  }
}

app.listen({ port, host: '0.0.0.0' }).then(() => {
  logger.info(`Agent runtime listening on port ${port}`);
});
```

**Step 2: Verify typecheck**

Run: `npm run typecheck -w agent-runtime`
Expected: PASS

**Step 3: Commit**

```bash
git add agent-runtime/src/server.ts
git commit -m "feat(agent-runtime): integrate task registration + idle monitor"
```

---

## Task 11: Update CDK agent-stack.ts — replace Service/ALB with RunTask infrastructure

**Files:**
- Modify: `infra/lib/agent-stack.ts`

**Step 1: Update AgentStackProps**

Add to the interface:

```typescript
  minWarmTasks?: number;
  idleTimeoutMinutes?: number;
```

**Step 2: Replace ECS Service/ALB block with dedicated task infrastructure**

In the `mode === 'ecs'` branch (starts around line 278), replace the entire block. Keep:
- ECS Cluster
- Log Group
- Task Definition (with updated environment variables)
- Security Group

Remove:
- `FargateService`
- `autoScaleTaskCount`
- ALB, ALB SecurityGroup, TargetGroup, Listener
- `scaleOnMetric` / scaling policy
- `cloudwatch` and `appscaling` imports

The new block should have:
- Cluster (keep)
- Task Definition with `AGENT_MODE=ecs`, `IDLE_TIMEOUT_MINUTES`, `SESSIONS_TABLE` env vars
- Security Group (keep, but update description)
- Export cluster name, task definition ARN, subnet IDs, security group ID as env vars for control-plane

Replace `this.agentEndpoint` with empty string (no ALB). Instead, add outputs for task infrastructure:

```typescript
      // Export task infrastructure for control-plane to use with RunTask
      new cdk.CfnOutput(this, 'AgentCluster', {
        value: cluster.clusterName,
        exportName: `nanoclawbot-${stage}-agent-cluster`,
      });
      new cdk.CfnOutput(this, 'AgentTaskDefinition', {
        value: agentTaskDef.taskDefinitionArn,
        exportName: `nanoclawbot-${stage}-agent-task-def`,
      });
```

Add `AGENT_MODE: 'ecs'`, `IDLE_TIMEOUT_MINUTES`, and `SESSIONS_TABLE` to the container environment.

**Step 3: Verify typecheck**

Run: `npm run typecheck -w infra`
Expected: PASS

**Step 4: Commit**

```bash
git add infra/lib/agent-stack.ts
git commit -m "feat(infra): replace ECS Service/ALB with RunTask infrastructure"
```

---

## Task 12: Update CDK control-plane-stack.ts — add ECS RunTask permissions

**Files:**
- Modify: `infra/lib/control-plane-stack.ts`

**Step 1: Add ECS task management permissions**

Replace the CloudWatch PutMetricData permission block with ECS RunTask/StopTask/DescribeTasks permissions:

```typescript
    // ECS — manage dedicated agent tasks (ecs mode only)
    if (props.mode === 'ecs') {
      taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'EcsManageTasks',
          effect: iam.Effect.ALLOW,
          actions: ['ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks'],
          resources: ['*'], // RunTask requires * for task resources
        }),
      );

      taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'PassAgentRoleForRunTask',
          effect: iam.Effect.ALLOW,
          actions: ['iam:PassRole'],
          resources: [props.agentBaseRole.roleArn],
        }),
      );
    }
```

**Step 2: Pass new env vars to control-plane container**

In the ECS mode env vars section, add:

```typescript
    AGENT_CLUSTER: props.agentCluster || '',
    AGENT_TASK_DEFINITION: props.agentTaskDefinitionArn || '',
    AGENT_SUBNETS: props.agentSubnets?.join(',') || '',
    AGENT_SECURITY_GROUP: props.agentSecurityGroup || '',
    MIN_WARM_TASKS: String(props.minWarmTasks ?? 2),
    IDLE_TIMEOUT_MINUTES: String(props.idleTimeoutMinutes ?? 60),
```

Update `ControlPlaneStackProps` to accept these new values.

**Step 3: Remove old CloudWatch PutMetricData permission and AGENT_ENDPOINT env var (for ECS mode)**

**Step 4: Verify typecheck**

Run: `npm run typecheck -w infra`
Expected: PASS

**Step 5: Commit**

```bash
git add infra/lib/control-plane-stack.ts
git commit -m "feat(infra): add ECS RunTask permissions for control-plane"
```

---

## Task 13: Update deploy.sh for new ECS architecture

**Files:**
- Modify: `scripts/deploy.sh`

**Step 1: Update ECS mode deployment steps**

The deploy script needs to:
- Pass new CDK outputs (cluster name, task def ARN, subnets, SG) to control-plane env vars
- Remove ALB-related steps for ECS mode
- No longer need AGENT_ENDPOINT for ECS mode (direct task IP routing)

**Step 2: Commit**

```bash
git add scripts/deploy.sh
git commit -m "fix(deploy): update for ECS dedicated task architecture"
```

---

## Task 14: End-to-end verification

**Step 1: Build all packages**

```bash
npm run build --workspaces
```

**Step 2: Typecheck all packages**

```bash
npm run typecheck -w shared
npm run typecheck -w control-plane
npm run typecheck -w agent-runtime
npm run typecheck -w infra
```

**Step 3: Run control-plane tests**

```bash
npm test -w control-plane
```

**Step 4: CDK synth both modes**

```bash
cd infra
npx cdk synth --context mode=ecs
npx cdk synth  # agentcore mode — should be unchanged
```

**Step 5: Deploy and test**

```bash
# Build and push Docker images
# Deploy CDK stacks
# Verify warm pool starts (check DynamoDB for warm records)
# Send messages to 3 different groups
# Verify each group gets its own task (check DynamoDB session records)
# Wait 1h idle — verify tasks self-stop
# Verify control-plane safety net scan cleans up stale records
```

**Step 6: Commit**

```bash
git commit -m "feat: ECS dedicated task per session mode"
```

---

## Verification Checklist

- [ ] `npm run typecheck` passes for all 4 packages (shared, control-plane, agent-runtime, infra)
- [ ] `npm test -w control-plane` passes
- [ ] `npx cdk synth --context mode=ecs` produces valid template
- [ ] `npx cdk synth` (agentcore mode) is unchanged
- [ ] Warm pool starts with `minWarmTasks` tasks on control-plane boot
- [ ] New session claims warm task → instant dispatch (no cold start)
- [ ] Same session reuses existing task → dispatch to same task IP
- [ ] Task self-stops after idle timeout
- [ ] Control-plane scan cleans up stale DynamoDB records
- [ ] Task crash → next dispatch detects and reassigns
- [ ] AgentCore mode completely unaffected
