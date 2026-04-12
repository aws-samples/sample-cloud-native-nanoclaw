# ECS Dedicated Task Mode — Design Document

> **Goal:** Replace the ECS shared service pool (single-concurrency per task, ALB routing) with a per-session dedicated task model where each `botId#groupJid` gets its own ECS task, eliminating 503 contention and simplifying scaling.

> **Scope:** ECS mode only (`mode=ecs`). AgentCore mode is unaffected.

## Architecture Overview

### Current (Shared Service Pool)

```
User → SQS FIFO → Consumer → ALB (LEAST_OUTSTANDING_REQUESTS) → [Task Pool 2-100]
                                    ↑ 503 if all busy → 5min internal retry
```

- ECS Service manages a pool of identical tasks behind an internal ALB
- Any task handles any session (no affinity)
- Single-concurrency: task returns 503 when busy
- Auto-scaling based on WaitingDispatchGroups custom metric
- S3 sync every invocation + workspace cleanup for tenant isolation

### New (Dedicated Task per Session)

```
User → SQS FIFO → Consumer → DynamoDB lookup → direct HTTP → dedicated task
                      ↓ (no task)
                  claim warm task → assign session → dispatch
                      ↓ (no warm task)
                  ecs:RunTask → poll until ready → dispatch
```

- Each `botId#groupJid` gets a dedicated ECS task
- Control-plane routes directly to task private IP (no ALB)
- Warm pool ensures instant dispatch for new sessions
- Task self-stops after idle timeout; control-plane scans as safety net

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Session state | Keep S3 sync per invocation | Simplicity; no change to persistence model |
| Cold start | Wait for task (poll in dispatch) | SQS message stays in-flight; user waits 30-90s for first message only |
| Routing | DynamoDB task registry | Reuses existing infrastructure; Sessions table extended |
| Lifecycle | Hybrid (task self-stop + control-plane scan) | Double guarantee against orphaned tasks |
| Warm pool | Configurable `minWarmTasks` (default 2) | Eliminates cold start for most new sessions |
| Idle timeout | Configurable `idleTimeoutMinutes` (default 60) | Cost optimization; task stops after 1h idle |

## CDK Parameters

```typescript
export interface AgentStackProps extends cdk.StackProps {
  // ... existing props
  /** Minimum warm tasks always ready (no cold start). Default: 2 */
  minWarmTasks?: number;
  /** Minutes of idle before session task stops. Default: 60 */
  idleTimeoutMinutes?: number;
}
```

Passed as environment variables:
- `MIN_WARM_TASKS=2` → control-plane (warm pool management)
- `IDLE_TIMEOUT_MINUTES=60` → agent-runtime (self-stop timer)

## DynamoDB Schema Changes

### Sessions Table — New Fields

```typescript
interface Session {
  // Existing fields (unchanged)
  botId: string;
  groupJid: string;
  agentcoreSessionId: string;
  s3SessionPath: string;
  lastActiveAt: string;
  status: 'active' | 'idle' | 'terminated';
  lastModel?: string;
  lastModelProvider?: ModelProvider;

  // New fields (ECS task registry)
  taskArn?: string;              // ECS task ARN
  taskIp?: string;               // Private IP for direct HTTP
  taskStatus?: 'warm' | 'running' | 'stopping' | 'stopped';
  lastInvocationAt?: string;     // For idle timeout detection
}
```

### Warm Task Records

Warm tasks have no session binding. Stored with a special key pattern:

```typescript
// PK: "warm#<taskArn>", SK: "task"
interface WarmTaskRecord {
  pk: 'warm';                    // GSI partition key for scanning
  sk: string;                    // taskArn
  taskArn: string;
  taskIp: string;
  taskStatus: 'warm' | 'assigned';
  startedAt: string;
}
```

## Task Lifecycle

### 1. Warm Pool Maintenance (control-plane)

```
startup → count warm tasks in DynamoDB
        → if count < minWarmTasks: RunTask to fill pool
        → periodic check every 30s: replenish if below min
```

### 2. Session Task Assignment

```
1. SQS message for botId#groupJid
2. Query Sessions table → taskStatus='running'?
   YES → direct HTTP POST to taskIp:8080/invocations
   NO  → claim a warm task from DynamoDB (atomic update)
       → if no warm task available: ecs:RunTask → poll until registered
       → update Sessions table: taskArn, taskIp, taskStatus='running'
       → dispatch to task (payload includes botId, groupJid, userId)
       → replenish warm pool (async, non-blocking)
```

### 3. Task Self-Registration (agent-runtime startup)

```
startup → fetch taskArn + privateIp from ECS metadata endpoint
        → write to DynamoDB (warm record or session record)
        → start HTTP server on port 8080
        → start idle timer (IDLE_TIMEOUT_MINUTES)
```

### 4. Task Self-Stop (idle timeout)

```
invocation received → reset idle timer
idle timer expires (1h) → final S3 sync
                        → update DynamoDB: taskStatus='stopped'
                        → process.exit(0)
```

### 5. Control-Plane Safety Net (periodic scan)

```
every 10 minutes → scan DynamoDB for taskStatus='running'
                    where lastInvocationAt > idleTimeoutMinutes
                 → verify task state via ecs:DescribeTasks
                 → if task stopped/missing: clean up DynamoDB record
                 → if task running but idle: ecs:StopTask
```

### 6. Task Crash Recovery

```
dispatch to taskIp → network error
  → ecs:DescribeTasks → task STOPPED/missing
  → clear DynamoDB: taskArn, taskIp, taskStatus='stopped'
  → re-run: claim warm task or RunTask
  → dispatch to new task
```

## Dispatch Flow (EcsTaskInvoker)

```typescript
class EcsTaskInvoker implements AgentInvoker {
  async invoke(payload, logger): Promise<InvocationResult> {
    const sessionKey = `${payload.botId}#${payload.groupJid}`;

    // 1. Lookup existing task
    const session = await getSession(payload.botId, payload.groupJid);
    let taskIp = session?.taskIp;

    if (session?.taskStatus === 'running' && taskIp) {
      // 2a. Try dispatch to existing task
      const result = await this.httpInvoke(taskIp, payload);
      if (result) return result;
      // Task gone — fall through to reassign
    }

    // 2b. Claim warm task or start new one
    taskIp = await this.assignTask(payload, logger);

    // 3. Dispatch to newly assigned task
    return this.httpInvoke(taskIp, payload);
  }
}
```

## Files to Create

| File | Purpose |
|------|---------|
| `control-plane/src/sqs/task-manager.ts` | Warm pool management, RunTask, StopTask, idle scan, DynamoDB warm record CRUD |
| `agent-runtime/src/idle-monitor.ts` | Idle timeout timer, triggers graceful shutdown |
| `agent-runtime/src/task-registration.ts` | ECS metadata → taskArn/IP → DynamoDB registration |

## Files to Modify

| File | Changes |
|------|---------|
| `control-plane/src/sqs/dispatcher.ts` | Replace `EcsHttpInvoker` with `EcsTaskInvoker`. Remove `AgentBusyError`, 503 retry loop, `isConsumerRunning` import |
| `control-plane/src/sqs/consumer.ts` | Remove `dispatchingGroups`, `WaitingDispatchGroups` metric, `CloudWatchClient`, `AgentBusyError` handler. Remove `isConsumerRunning` export. Simplify dispatch error handling |
| `control-plane/src/index.ts` | Initialize task-manager on startup (warm pool + idle scan timer) |
| `control-plane/src/services/dynamo.ts` | Add warm task CRUD: `putWarmTask`, `claimWarmTask`, `listWarmTasks`, `scanIdleTasks`. Extend `putSession` with task fields |
| `control-plane/src/config.ts` | Add `minWarmTasks`, `idleTimeoutMinutes`, `agentCluster`, `agentTaskDefinition` |
| `agent-runtime/src/server.ts` | Call task-registration on startup. Reset idle timer on each invocation. Remove `busy` flag (dedicated task, no 503) |
| `agent-runtime/src/agent.ts` | First invocation binds session info from payload |
| `infra/lib/agent-stack.ts` | ECS mode: remove Service, ALB, auto-scaling. Keep Task Definition + IAM roles. Add ECS cluster (for RunTask). Add `minWarmTasks`/`idleTimeoutMinutes` as env vars |
| `infra/lib/control-plane-stack.ts` | Add `ecs:RunTask`, `ecs:StopTask`, `ecs:DescribeTasks` permissions. Remove `cloudwatch:PutMetricData` |
| `shared/src/types.ts` | Session type: add `taskArn`, `taskIp`, `taskStatus`, `lastInvocationAt` fields |

## Files/Code to Remove

| Remove | Reason |
|--------|--------|
| ALB + Target Group + Listener (CDK) | No load balancer needed |
| `scaleOnMetric` / auto-scaling (CDK) | No auto-scaling policy needed |
| `AgentBusyError` class | Dedicated tasks don't return 503 |
| `isConsumerRunning()` export | No shutdown check needed in dispatcher |
| `WaitingDispatchGroups` metric code | No CloudWatch custom metric needed |
| `dispatchingGroups` Set | No dispatch group tracking needed |
| CloudWatch PutMetricData IAM permission | No custom metrics |

## Mode Isolation

All changes are gated by `mode === 'ecs'`:

```typescript
// dispatcher.ts
function createInvoker(): AgentInvoker {
  if (config.agentMode === 'ecs') return new EcsTaskInvoker();  // NEW
  return new AgentCoreInvoker();  // UNCHANGED
}

// agent-stack.ts
if (mode === 'ecs') {
  // NEW: Task Definition + warm pool config
  // REMOVED: ECS Service, ALB, auto-scaling
} else {
  // UNCHANGED: agentcore branch
}

// agent-runtime — conditional activation
if (process.env.AGENT_MODE === 'ecs') {
  // task-registration + idle-monitor
}
```

## Security

- **IAM ABAC unchanged**: Tasks still use STS AssumeRole with session tags (userId, botId)
- **Warm tasks**: No ABAC tags until session assigned. First invocation payload provides userId/botId for STS tag session
- **Network**: Tasks in private subnets. Control-plane → task communication via VPC private IPs
- **DynamoDB**: Warm task records use separate key pattern, no cross-tenant access risk

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Two messages for same session arrive simultaneously | SQS FIFO ensures serial delivery. Second message waits until first is deleted |
| Warm pool empty when new session arrives | Cold start: RunTask → poll → dispatch (~30-90s) |
| Task crashes mid-invocation | Message returns to queue after 600s visibility timeout. Next dispatch detects dead task, assigns new one |
| Control-plane restart | Warm pool state in DynamoDB survives. Periodic scan resumes. No task disruption |
| Model change (forceNewSession) | Same task handles the request; agent-runtime resets session internally as today |
| Multiple control-plane replicas | DynamoDB atomic operations (ConditionExpression) prevent double-claiming warm tasks |
