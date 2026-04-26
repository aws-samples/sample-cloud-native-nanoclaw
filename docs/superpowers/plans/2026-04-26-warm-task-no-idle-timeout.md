# Warm Task No-Idle-Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the infinite warm-pool cold-start loop in ECS mode (≈100 GB/day of ECR image pulls through NAT Gateway) by making `IDLE_TIMEOUT_MINUTES` apply only to tasks that have been claimed for a session. Image-staleness of long-lived warm tasks is handled by `deploy.sh` explicitly `StopTask`-ing all warm tasks at deploy time.

**Architecture:**
- In `agent-runtime/src/server.ts`, defer `startIdleMonitor()` from startup to the **first** `/invocations` request — that is the exact moment the task transitions warm → dedicated.
- Harden `agent-runtime/src/idle-monitor.ts` so `resetIdleTimer()` is a no-op when the monitor has not been started (fixes a latent bug where it would call `setTimeout(fn, undefined)` and fire immediately).
- Add a new ECS-mode-only step to `scripts/deploy.sh` that queries the sessions DynamoDB table for `pk='warm'` records and calls `StopTask` on each. The Control Plane's warm-pool replenisher (running every 3 min) automatically backfills with the new image.

**Tech Stack:** TypeScript (ESM, strict), Fastify, Vitest, AWS SDK v3 (`@aws-sdk/client-ecs`, `@aws-sdk/client-dynamodb`), bash + aws-cli.

---

## File Structure

**Modify:**
- `agent-runtime/src/idle-monitor.ts` — add a "not started" guard to `resetIdleTimer`.
- `agent-runtime/src/server.ts` — replace the unconditional startup `startIdleMonitor()` call with lazy start on first `/invocations`.
- `scripts/deploy.sh` — insert a new ECS-mode-only step after Step 11 (force ECS deploy) that stops all warm agent tasks.

**Create:**
- `agent-runtime/src/__tests__/idle-monitor.test.ts` — unit tests for `startIdleMonitor` / `resetIdleTimer` / `pauseIdleTimer` lifecycle, particularly the "not-started" no-op behavior.

**No changes needed to:** `infra/`, `control-plane/`, `shared/`, or any other package. Warm pool replenisher already handles automatic backfill after `StopTask`.

---

## Task 1: Failing test for `idle-monitor` lifecycle

**Files:**
- Create: `agent-runtime/src/__tests__/idle-monitor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `agent-runtime/src/__tests__/idle-monitor.test.ts` with exactly:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';

const logger: Logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
} as unknown as Logger;

describe('idle-monitor', () => {
  let startIdleMonitor: typeof import('../idle-monitor.js').startIdleMonitor;
  let resetIdleTimer: typeof import('../idle-monitor.js').resetIdleTimer;
  let pauseIdleTimer: typeof import('../idle-monitor.js').pauseIdleTimer;
  let stopIdleMonitor: typeof import('../idle-monitor.js').stopIdleMonitor;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    (logger.info as ReturnType<typeof vi.fn>).mockReset();
    (logger.error as ReturnType<typeof vi.fn>).mockReset();
    const mod = await import('../idle-monitor.js');
    startIdleMonitor = mod.startIdleMonitor;
    resetIdleTimer = mod.resetIdleTimer;
    pauseIdleTimer = mod.pauseIdleTimer;
    stopIdleMonitor = mod.stopIdleMonitor;
  });

  afterEach(() => {
    stopIdleMonitor();
    vi.useRealTimers();
  });

  it('resetIdleTimer is a no-op when startIdleMonitor has not been called', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    resetIdleTimer();
    // Advance far past any realistic timeout; nothing should fire.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('pauseIdleTimer is a no-op before startIdleMonitor (does not throw)', () => {
    expect(() => pauseIdleTimer()).not.toThrow();
  });

  it('startIdleMonitor schedules process.exit after the configured timeout', async () => {
    const onTimeout = vi.fn().mockResolvedValue(undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    startIdleMonitor(logger, 1 /* minute */, onTimeout);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });

  it('resetIdleTimer after startIdleMonitor pushes the deadline forward', async () => {
    const onTimeout = vi.fn().mockResolvedValue(undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    startIdleMonitor(logger, 1, onTimeout);

    await vi.advanceTimersByTimeAsync(30_000);
    resetIdleTimer();
    await vi.advanceTimersByTimeAsync(30_000);
    // Without reset the timer would have fired at 60s. Because we reset at 30s,
    // the deadline is now 30s + 60s = 90s. So at t=60s nothing has fired.
    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(31_000);
    // At t=91s we are past the new deadline (90s).
    expect(onTimeout).toHaveBeenCalledTimes(1);

    exitSpy.mockRestore();
  });

  it('pauseIdleTimer after startIdleMonitor prevents firing until resetIdleTimer is called', async () => {
    const onTimeout = vi.fn().mockResolvedValue(undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    startIdleMonitor(logger, 1, onTimeout);
    pauseIdleTimer();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(onTimeout).not.toHaveBeenCalled();

    resetIdleTimer();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    exitSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the tests — expect ONE failure**

Run (from `/home/ubuntu/workspace/sample-cloud-native-nanoclaw`):

```
npm test -w agent-runtime -- idle-monitor
```

Expected:
- The first test (`resetIdleTimer is a no-op when startIdleMonitor has not been called`) FAILS — current code calls `setTimeout(fn, undefined)` which fires immediately and calls `process.exit`, so the `exitSpy` WILL have been called.
- The other 4 tests PASS already (regression guards).

If the first test passes already, STOP and report — you've found a case where Node's `setTimeout` no longer accepts `undefined`, which would invalidate the premise of Task 2.

- [ ] **Step 3: Commit the failing test**

```
git add agent-runtime/src/__tests__/idle-monitor.test.ts
git commit -m "test(agent-runtime): failing test for idle-monitor not-started guard"
```

---

## Task 2: Harden `resetIdleTimer` to be a no-op before `startIdleMonitor`

**Files:**
- Modify: `agent-runtime/src/idle-monitor.ts`

- [ ] **Step 1: Add a guard in `resetIdleTimer`**

Edit `/home/ubuntu/workspace/sample-cloud-native-nanoclaw/agent-runtime/src/idle-monitor.ts`. Find the existing `resetIdleTimer` function (lines 24-38):

```ts
/** Reset the idle timer (call when invocation completes or on startup). */
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
```

Replace with:

```ts
/** Reset the idle timer (call when invocation completes or on startup).
 *  No-op before startIdleMonitor has been called — this lets warm tasks
 *  defer monitor activation until they take their first invocation. */
export function resetIdleTimer(): void {
  if (onTimeout === null) return;
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
```

- [ ] **Step 2: Run the tests — all 5 must pass**

```
npm test -w agent-runtime -- idle-monitor
```

Expected: 5/5 pass.

- [ ] **Step 3: Run full agent-runtime test suite to check for regressions**

```
npm test -w agent-runtime
```

Expected: all tests pass.

- [ ] **Step 4: Type-check and build**

```
npm run typecheck -w agent-runtime
npm run build -w agent-runtime
```

Both exit 0.

- [ ] **Step 5: Commit**

```
git add agent-runtime/src/idle-monitor.ts
git commit -m "fix(agent-runtime): make resetIdleTimer a no-op before startIdleMonitor"
```

---

## Task 3: Defer `startIdleMonitor` to first `/invocations` in `server.ts`

**Files:**
- Modify: `agent-runtime/src/server.ts`

- [ ] **Step 1: Remove `startIdleMonitor` from the startup block**

Edit `/home/ubuntu/workspace/sample-cloud-native-nanoclaw/agent-runtime/src/server.ts`. Find this existing block (lines 104-117):

```ts
// ECS dedicated task mode — register after server is ready
if (process.env.AGENT_MODE === 'ecs') {
  try {
    const meta = await registerTask(logger);
    logger.info({ taskArn: meta.taskArn }, 'ECS task registered');

    const idleMinutes = Number(process.env.IDLE_TIMEOUT_MINUTES) || 60;
    startIdleMonitor(logger, idleMinutes, async () => {
      logger.info('Idle timeout — performing graceful shutdown');
    });
  } catch (err) {
    logger.error(err, 'Failed to register ECS task');
  }
}
```

Replace with:

```ts
// ECS dedicated task mode — register as warm. Idle monitor is deferred
// to the first /invocations (see below) so warm tasks do NOT exit and
// force the control-plane warm-pool replenisher into a ~$$$/day cold-start loop.
if (process.env.AGENT_MODE === 'ecs') {
  try {
    const meta = await registerTask(logger);
    logger.info({ taskArn: meta.taskArn }, 'ECS task registered');
  } catch (err) {
    logger.error(err, 'Failed to register ECS task');
  }
}
```

- [ ] **Step 2: Add a module-level flag and lazy-start helper near the top of `server.ts`**

Edit the same file. Find the existing "Busy state tracking" block (around lines 28-31):

```ts
// Busy state tracking — reflects whether the agent is currently processing
let busy = false;
export function setBusy() { busy = true; }
export function setIdle() { busy = false; }
```

Insert the following block immediately AFTER it (before the `app.get('/ping', ...)` route):

```ts
// Idle monitor is deferred until the first /invocations — that is the moment
// this container stops being a "warm pool" member and becomes a dedicated,
// session-bound task. Tracked with a flag so we only start the monitor once.
let idleMonitorStarted = false;
function ensureIdleMonitorStarted() {
  if (idleMonitorStarted) return;
  if (process.env.AGENT_MODE !== 'ecs') return;
  const idleMinutes = Number(process.env.IDLE_TIMEOUT_MINUTES) || 60;
  startIdleMonitor(logger, idleMinutes, async () => {
    logger.info('Idle timeout — performing graceful shutdown');
  });
  idleMonitorStarted = true;
  logger.info({ idleMinutes }, 'Idle monitor activated (task transitioned warm -> dedicated)');
}
```

- [ ] **Step 3: Call `ensureIdleMonitorStarted()` at the start of the `/invocations` handler**

In the same file, find the existing handler (around lines 39-47):

```ts
app.post<{ Body: InvocationPayload }>('/invocations', async (request, reply) => {
  const payload = request.body;
  // Reject concurrent requests — single-concurrency per task in both modes.
  // SQS FIFO + deferred deletion prevents this in normal operation, but
  // 503 rejection is a safety net against edge cases (CP restart, receipt expiry).
  if (busy) {
    logger.info({ botId: payload.botId, groupJid: payload.groupJid }, 'Agent busy, rejecting request');
    return reply.status(503).send({ error: 'Agent is busy' });
  }
```

Insert a single line IMMEDIATELY AFTER `const payload = request.body;`:

```ts
  ensureIdleMonitorStarted();
```

(So the line order becomes: `const payload = request.body;` → `ensureIdleMonitorStarted();` → the `if (busy)` block.)

- [ ] **Step 4: Type-check and build**

```
npm run typecheck -w agent-runtime
npm run build -w agent-runtime
```

Both exit 0.

- [ ] **Step 5: Run agent-runtime tests (no regressions)**

```
npm test -w agent-runtime
```

Expected: all tests pass, including the 5 idle-monitor tests.

- [ ] **Step 6: Commit**

```
git add agent-runtime/src/server.ts
git commit -m "fix(agent-runtime): defer idle monitor to first /invocations (warm-pool fix)"
```

---

## Task 4: Add `StopTask`-all-warm step to `scripts/deploy.sh`

**Files:**
- Modify: `scripts/deploy.sh`

- [ ] **Step 1: Locate the insertion point**

Open `scripts/deploy.sh` and locate the end of the control-plane ECS rolling-deploy block. Specifically:
- Step 11 (`Force new ECS deployment`) is agentcore-mode only, guarded by `if [ "$DEPLOY_MODE" = "agentcore" ]; then ... fi` (closing `fi` appears around line 356).
- Find the NEXT `log "Step 12: ..."` line (web-console build) — our new step must appear BEFORE it.

- [ ] **Step 2: Insert the new step**

Immediately BEFORE the `log "Step 12: Build web-console"` line in `scripts/deploy.sh`, insert the following block (replace `PREFIX`/`STAGE`/`REGION` variable references with those already defined at the top of the script — they exist):

```bash
# ── Step 11b: (ECS mode only) Stop warm agent tasks to force image refresh ────
# Warm agent-runtime tasks no longer exit on idle, so they would otherwise run
# stale images indefinitely. Stop them here; the control-plane warm-pool
# replenisher will backfill from the newly-pushed image within ~3 min.
if [ "$DEPLOY_MODE" = "ecs" ]; then
  log "Step 11b: Stopping warm agent tasks to pick up new agent-runtime image"
  SESSIONS_TABLE="${PREFIX}-${STAGE}-sessions"
  AGENT_CLUSTER=$(get_stack_output "${STACK_PREFIX}-Agent" "AgentClusterName")
  if [ -z "$AGENT_CLUSTER" ] || [ "$AGENT_CLUSTER" = "None" ]; then
    log "  WARN: Could not resolve AgentClusterName, skipping"
  else
    WARM_ARNS=$(aws dynamodb query \
      --table-name "$SESSIONS_TABLE" \
      --key-condition-expression "pk = :pk" \
      --expression-attribute-values '{":pk":{"S":"warm"}}' \
      --projection-expression "taskArn" \
      --region "$REGION" \
      --query 'Items[].taskArn.S' \
      --output text 2>/dev/null || echo "")
    if [ -n "$WARM_ARNS" ] && [ "$WARM_ARNS" != "None" ]; then
      COUNT=0
      for arn in $WARM_ARNS; do
        aws ecs stop-task \
          --cluster "$AGENT_CLUSTER" \
          --task "$arn" \
          --reason "deploy image refresh" \
          --region "$REGION" >/dev/null 2>&1 || true
        COUNT=$((COUNT + 1))
      done
      log "  Stopped ${COUNT} warm agent task(s) — replenisher will backfill"
    else
      log "  No warm tasks registered in DynamoDB"
    fi
  fi
fi

```

(Note the blank line at the end — preserves existing spacing before Step 12.)

- [ ] **Step 3: Sanity-check the script parses**

```
bash -n scripts/deploy.sh
```

Expected: exit 0 (no syntax errors).

- [ ] **Step 4: Dry-run the AWS CLI commands we added (no mutation)**

Simulate the DynamoDB query only (does not call `stop-task`). From `/home/ubuntu/workspace/sample-cloud-native-nanoclaw`:

```
aws dynamodb query \
  --table-name nanoclawbot-dev-sessions \
  --key-condition-expression "pk = :pk" \
  --expression-attribute-values '{":pk":{"S":"warm"}}' \
  --projection-expression "taskArn" \
  --region us-west-2 \
  --query 'Items[].taskArn.S' \
  --output text
```

Expected: either empty (agentcore mode → no warm tasks) OR a tab-separated list of task ARNs. Either way, no error.

- [ ] **Step 5: Commit**

```
git add scripts/deploy.sh
git commit -m "chore(deploy): stop warm agent tasks at deploy time (ECS mode)"
```

---

## Task 5: Final verification

- [ ] **Step 1: Full agent-runtime test suite**

```
npm test -w agent-runtime
```

Expected: all tests pass.

- [ ] **Step 2: Build all touched workspaces**

```
npm run build -w agent-runtime
```

Expected: exit 0.

- [ ] **Step 3: Confirm commit log matches plan**

```
git log --oneline main..HEAD
```

Expected in order:
1. `test(agent-runtime): failing test for idle-monitor not-started guard`
2. `fix(agent-runtime): make resetIdleTimer a no-op before startIdleMonitor`
3. `fix(agent-runtime): defer idle monitor to first /invocations (warm-pool fix)`
4. `chore(deploy): stop warm agent tasks at deploy time (ECS mode)`

(Plan doc commit may precede these if committed separately.)

- [ ] **Step 4: Grep for residual references**

```
grep -n "startIdleMonitor\|ensureIdleMonitorStarted" agent-runtime/src
```

Expected:
- `idle-monitor.ts` — defines `startIdleMonitor`.
- `server.ts` — imports `startIdleMonitor`; defines and calls `ensureIdleMonitorStarted`.
- NO call to `startIdleMonitor` inside the `if (process.env.AGENT_MODE === 'ecs')` startup block any more.

```
grep -n "deploy image refresh\|Step 11b" scripts/deploy.sh
```

Expected: the new step block is in place.

---

## Testing Strategy

**Unit (automated, part of `npm test -w agent-runtime`):**
- `idle-monitor.test.ts` — 5 cases covering: no-op before start, pauseIdleTimer safe before start, normal timeout fires, reset pushes deadline forward, pause halts firing until reset.

**Manual / deployment verification (out of scope for this plan):**
- Deploy to the ECS-mode stage. Before deploy, count ECR image-pull events per day — should be >100.
- 24 h after deploy: re-count. Should drop to near-zero (only deploys + genuine cold-starts trigger pulls).
- Trigger a real user message: verify the claimed warm task DOES exit after `IDLE_TIMEOUT_MINUTES` of post-invocation idleness (dedicated-task semantics preserved).
- Run `deploy.sh` again: verify warm tasks are stopped and replenished with the new image revision.

---

## Non-Goals

- **Not** changing `IDLE_TIMEOUT_MINUTES` default (still 60 min in code, 15 min via task def env override — unchanged).
- **Not** adding an in-container max-lifetime safety net for warm tasks (chose deploy.sh explicit StopTask per user direction).
- **Not** touching `control-plane/src/sqs/task-manager.ts` — the warm-pool replenisher, claim logic, and stale-record eviction are correct. They simply stop observing the pathological cycle once warm tasks stop exiting.
- **Not** modifying `agent-runtime/src/task-registration.ts` — the registration-as-warm behavior stays unchanged.
- **Not** touching agentcore mode (no warm pool there).
