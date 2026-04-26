# SQS Visibility Renewal & 503 Suppression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop AgentCore `503 Agent busy` errors from surfacing to end users during long-running agent tasks, by (a) periodically renewing the SQS inbound message visibility timeout while the agent is running, and (b) suppressing the user-visible "Failed to start processing" reply when AgentCore 503 coincides with an in-flight invocation on the same group.

**Architecture:**
- New module `control-plane/src/sqs/visibility-extender.ts` owns a process-local `Map<receiptHandle, IntervalId>`. `startRenewal` is called from `consumer.ts` after the dispatcher returns (message is now "pending-reply"); `stopRenewal` is called from `reply-consumer.ts` immediately before `DeleteMessageCommand`. Renewal calls `ChangeMessageVisibilityCommand` every 5 minutes to extend visibility by another 600 s; renewal stops automatically after 12 renewals (~1 hour) as a safety cap.
- `AgentCoreInvoker.invoke()` gains a new return status `'busy_retry'` when the underlying AWS SDK surfaces a 503 from the runtime (`RuntimeClientError` with the runtime's 503 inside the message). `dispatchMessage` routes `'busy_retry'` to a log-only path — no `sendChannelReply`, no user-visible error.

**Tech Stack:** TypeScript (ESM, strict), AWS SDK v3 `@aws-sdk/client-sqs`, Fastify runtime, Vitest for tests.

---

## File Structure

**Create:**
- `control-plane/src/sqs/visibility-extender.ts` — module owning the renewal `Map`. Exports `startRenewal(handle, queueUrl, logger, opts?)`, `stopRenewal(handle)`, `__resetForTests()` (for vitest only).
- `control-plane/src/__tests__/visibility-extender.test.ts` — unit tests with mocked SQS client and fake timers.

**Modify:**
- `control-plane/src/sqs/consumer.ts:180-217` — call `startRenewal` after `touchSessionTask` persists the receipt handle.
- `control-plane/src/sqs/reply-consumer.ts:158-169` — call `stopRenewal` immediately before `DeleteMessageCommand` for the pending handle.
- `control-plane/src/sqs/dispatcher.ts:645-707` (`AgentCoreInvoker.invoke`) — detect 503-from-runtime inside the caught error, return `status: 'busy_retry'`.
- `control-plane/src/sqs/dispatcher.ts:443-454` (`dispatchMessage` error branch) — branch on `'busy_retry'`, log-only, no `sendChannelReply`.
- `shared/src/types.ts:345-351` — extend `InvocationResult['status']` union to include `'busy_retry'`.
- `control-plane/src/__tests__/dispatcher.test.ts` — new test cases for 503 detection.

---

## Task 1: Extend `InvocationResult` status union

**Files:**
- Modify: `shared/src/types.ts:345-351`

- [ ] **Step 1: Read the current type**

Run:
```bash
sed -n '344,352p' shared/src/types.ts
```

Expected output (unchanged before edit):
```ts
// Evolved from NanoClaw's ContainerOutput (stdout markers)
export interface InvocationResult {
  status: 'success' | 'error' | 'accepted';
  result: string | null;
  newSessionId?: string;
  tokensUsed?: number;
  error?: string;
}
```

- [ ] **Step 2: Add `'busy_retry'` to the union**

Edit `shared/src/types.ts`. Replace the single-line `status:` field so it becomes:
```ts
  /** `busy_retry` = transient 503 from a re-delivered inbound message; caller must not notify the user. */
  status: 'success' | 'error' | 'accepted' | 'busy_retry';
```

- [ ] **Step 3: Build shared to make the new type visible to control-plane**

Run:
```bash
npm run build -w shared
```

Expected: exit 0, `shared/dist/types.d.ts` contains `'busy_retry'`.

Verify:
```bash
grep "busy_retry" shared/dist/types.d.ts
```

- [ ] **Step 4: Commit**

```bash
git add shared/src/types.ts shared/dist
git commit -m "feat(shared): add 'busy_retry' status to InvocationResult"
```

---

## Task 2: Write failing test for `visibility-extender`

**Files:**
- Create: `control-plane/src/__tests__/visibility-extender.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `control-plane/src/__tests__/visibility-extender.test.ts` with exactly:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';

const mockSend = vi.fn();
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  ChangeMessageVisibilityCommand: vi.fn().mockImplementation((input: unknown) => input),
}));

vi.mock('../config.js', () => ({
  config: { region: 'us-east-1' },
}));

const logger: Logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
} as unknown as Logger;

describe('visibility-extender', () => {
  let startRenewal: typeof import('../sqs/visibility-extender.js').startRenewal;
  let stopRenewal: typeof import('../sqs/visibility-extender.js').stopRenewal;
  let __resetForTests: typeof import('../sqs/visibility-extender.js').__resetForTests;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    const mod = await import('../sqs/visibility-extender.js');
    startRenewal = mod.startRenewal;
    stopRenewal = mod.stopRenewal;
    __resetForTests = mod.__resetForTests;
  });

  afterEach(() => {
    __resetForTests();
    vi.useRealTimers();
  });

  it('schedules a ChangeMessageVisibility call after the interval elapses', async () => {
    startRenewal('handle-1', 'https://sqs/queue', logger, {
      intervalMs: 60_000,
      extendSeconds: 600,
    });

    expect(mockSend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0];
    expect(command.QueueUrl).toBe('https://sqs/queue');
    expect(command.ReceiptHandle).toBe('handle-1');
    expect(command.VisibilityTimeout).toBe(600);
  });

  it('renews repeatedly every interval until stopped', async () => {
    startRenewal('handle-2', 'https://sqs/queue', logger, {
      intervalMs: 30_000,
      extendSeconds: 600,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockSend).toHaveBeenCalledTimes(3);

    stopRenewal('handle-2');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('caps renewals at maxRenewals (safety stop)', async () => {
    startRenewal('handle-3', 'https://sqs/queue', logger, {
      intervalMs: 1_000,
      extendSeconds: 600,
      maxRenewals: 2,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('startRenewal is idempotent for the same handle (does not duplicate timers)', async () => {
    startRenewal('handle-4', 'https://sqs/queue', logger, { intervalMs: 1_000, extendSeconds: 600 });
    startRenewal('handle-4', 'https://sqs/queue', logger, { intervalMs: 1_000, extendSeconds: 600 });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('stopRenewal on an unknown handle is a no-op (does not throw)', () => {
    expect(() => stopRenewal('never-started')).not.toThrow();
  });

  it('continues renewing when a single SQS call rejects (best-effort)', async () => {
    mockSend.mockRejectedValueOnce(new Error('throttle'));
    mockSend.mockResolvedValue({});

    startRenewal('handle-5', 'https://sqs/queue', logger, { intervalMs: 1_000, extendSeconds: 600 });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:
```bash
npm test -w control-plane -- visibility-extender
```

Expected: FAIL with "Failed to resolve import" or similar — the module doesn't exist yet.

- [ ] **Step 3: Commit the failing test**

```bash
git add control-plane/src/__tests__/visibility-extender.test.ts
git commit -m "test(control-plane): failing test for visibility-extender module"
```

---

## Task 3: Implement `visibility-extender`

**Files:**
- Create: `control-plane/src/sqs/visibility-extender.ts`

- [ ] **Step 1: Implement the module**

Create `control-plane/src/sqs/visibility-extender.ts` with exactly:

```ts
// ClawBot Cloud — SQS Visibility Timeout Extender
//
// When a long-running agent holds an inbound SQS message in flight, the
// receiptHandle's visibility timeout (set to 600s on receive) would otherwise
// expire and SQS would re-deliver the same message — causing a second
// AgentCore invocation that hits the busy microVM and returns 503.
//
// This module renews visibility periodically via ChangeMessageVisibility
// until the reply-consumer deletes the message (agent finished) or the
// safety cap (maxRenewals) is reached.

import {
  SQSClient,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { config } from '../config.js';
import type { Logger } from 'pino';

const sqs = new SQSClient({ region: config.region });

interface RenewalOptions {
  /** Interval between renewals in ms. Default 300_000 (5 min). */
  intervalMs?: number;
  /** New visibility timeout in seconds each renewal. Default 600 (10 min). */
  extendSeconds?: number;
  /** Safety cap on the number of renewals (prevents runaway timers). Default 12 (~1 hour). */
  maxRenewals?: number;
}

interface RenewalState {
  timer: NodeJS.Timeout;
  count: number;
  max: number;
}

const renewals = new Map<string, RenewalState>();

const DEFAULT_INTERVAL_MS = 300_000;
const DEFAULT_EXTEND_SECONDS = 600;
const DEFAULT_MAX_RENEWALS = 12;

/**
 * Begin periodic visibility renewal for the given receiptHandle.
 * Idempotent — calling twice for the same handle is a no-op.
 */
export function startRenewal(
  receiptHandle: string,
  queueUrl: string,
  logger: Logger,
  opts: RenewalOptions = {},
): void {
  if (renewals.has(receiptHandle)) return;

  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const extendSeconds = opts.extendSeconds ?? DEFAULT_EXTEND_SECONDS;
  const max = opts.maxRenewals ?? DEFAULT_MAX_RENEWALS;

  const state: RenewalState = {
    timer: setInterval(() => {
      const current = renewals.get(receiptHandle);
      if (!current) return;

      if (current.count >= current.max) {
        logger.warn(
          { receiptHandle: truncateHandle(receiptHandle), count: current.count },
          'SQS visibility renewal hit maxRenewals cap, stopping',
        );
        clearInterval(current.timer);
        renewals.delete(receiptHandle);
        return;
      }

      current.count += 1;
      sqs
        .send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: extendSeconds,
          }),
        )
        .then(() => {
          logger.debug(
            {
              receiptHandle: truncateHandle(receiptHandle),
              count: current.count,
              extendSeconds,
            },
            'SQS visibility renewed',
          );
        })
        .catch((err) => {
          // Best-effort: if renewal fails (expired handle, throttle), log and keep trying.
          // The underlying message will be re-delivered when visibility actually expires.
          logger.warn(
            {
              receiptHandle: truncateHandle(receiptHandle),
              count: current.count,
              err,
            },
            'SQS visibility renewal failed',
          );
        });
    }, intervalMs),
    count: 0,
    max,
  };

  // Allow the process to exit even if this timer is still scheduled.
  state.timer.unref?.();

  renewals.set(receiptHandle, state);
}

/**
 * Stop renewing visibility for the given receiptHandle.
 * Safe to call on an unknown handle.
 */
export function stopRenewal(receiptHandle: string): void {
  const state = renewals.get(receiptHandle);
  if (!state) return;
  clearInterval(state.timer);
  renewals.delete(receiptHandle);
}

/** Truncate the opaque receipt handle for log readability. */
function truncateHandle(handle: string): string {
  return handle.length > 24 ? `${handle.slice(0, 12)}...${handle.slice(-8)}` : handle;
}

/** Test-only hook to clear all in-flight renewals between runs. */
export function __resetForTests(): void {
  for (const state of renewals.values()) {
    clearInterval(state.timer);
  }
  renewals.clear();
}
```

- [ ] **Step 2: Run the tests and verify they pass**

Run:
```bash
npm test -w control-plane -- visibility-extender
```

Expected: 6 tests pass (schedules once, renews repeatedly, caps at max, idempotent, unknown stop is no-op, continues on error).

- [ ] **Step 3: Build to catch type errors**

Run:
```bash
npm run build -w control-plane
```

Expected: exit 0, `control-plane/dist/sqs/visibility-extender.js` exists.

- [ ] **Step 4: Commit**

```bash
git add control-plane/src/sqs/visibility-extender.ts control-plane/dist/sqs
git commit -m "feat(control-plane): add visibility-extender module for SQS renewal"
```

---

## Task 4: Hook up `startRenewal` in the SQS consumer

**Files:**
- Modify: `control-plane/src/sqs/consumer.ts` (imports + the `.then` callback around lines 185-217)

- [ ] **Step 1: Add the import**

Edit `control-plane/src/sqs/consumer.ts`. Find the existing import block at the top (lines 4-14) and add a new import line right after the `import { dispatch } from './dispatcher.js';` line:

```ts
import { startRenewal } from './visibility-extender.js';
```

- [ ] **Step 2: Call `startRenewal` after the receipt handle is persisted**

Edit `control-plane/src/sqs/consumer.ts:202-210`. Replace this block:

```ts
            if (groupKey) {
              // Store receipt handle in DynamoDB (survives control-plane restarts).
              // Reply-consumer reads it to delete the inbound message when agent completes.
              const [botId, ...rest] = groupKey.split('#');
              const groupJid = rest.join('#');
              await touchSessionTask(botId, groupJid, handle).catch((err) =>
                logger.warn({ err, key: groupKey }, 'Failed to persist pending receipt handle'),
              );
              logger.debug({ key: groupKey, messageId: msg.MessageId }, 'Deferred SQS delete until agent reply');
            } else {
```

With:

```ts
            if (groupKey) {
              // Store receipt handle in DynamoDB (survives control-plane restarts).
              // Reply-consumer reads it to delete the inbound message when agent completes.
              const [botId, ...rest] = groupKey.split('#');
              const groupJid = rest.join('#');
              await touchSessionTask(botId, groupJid, handle).catch((err) =>
                logger.warn({ err, key: groupKey }, 'Failed to persist pending receipt handle'),
              );
              // Periodically extend visibility while the agent is running so the
              // inbound message is NOT re-delivered during long tasks (>10 min).
              // reply-consumer.ts calls stopRenewal() right before it deletes.
              startRenewal(handle, config.queues.messages, logger);
              logger.debug({ key: groupKey, messageId: msg.MessageId }, 'Deferred SQS delete until agent reply');
            } else {
```

- [ ] **Step 3: Type-check**

Run:
```bash
npm run typecheck -w control-plane
```

Expected: exit 0.

- [ ] **Step 4: Run existing tests to ensure nothing broke**

Run:
```bash
npm test -w control-plane
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/sqs/consumer.ts
git commit -m "feat(control-plane): renew SQS visibility while agent is running"
```

---

## Task 5: Hook up `stopRenewal` in the reply consumer

**Files:**
- Modify: `control-plane/src/sqs/reply-consumer.ts` (imports + the pending-delete block around lines 153-170)

- [ ] **Step 1: Add the import**

Edit `control-plane/src/sqs/reply-consumer.ts`. After the existing `import { ... } from '../services/dynamo.js'` block (lines 17-23), add:

```ts
import { stopRenewal } from './visibility-extender.js';
```

- [ ] **Step 2: Call `stopRenewal` before deleting the deferred message**

Edit `control-plane/src/sqs/reply-consumer.ts:158-170`. Replace this block:

```ts
                if (pendingHandle) {
                  try {
                    await sqs.send(new DeleteMessageCommand({
                      QueueUrl: config.queues.messages,
                      ReceiptHandle: pendingHandle,
                    }));
                    await clearPendingHandle(payload.botId, payload.groupJid);
                    logger.info({ key: `${payload.botId}#${payload.groupJid}` }, 'Deferred inbound message deleted (agent completed)');
                  } catch (delErr) {
                    logger.warn({ key: `${payload.botId}#${payload.groupJid}`, err: delErr }, 'Failed to delete deferred inbound message (may have expired)');
                    await clearPendingHandle(payload.botId, payload.groupJid).catch(() => {});
                  }
                }
```

With:

```ts
                if (pendingHandle) {
                  // Stop visibility renewal *before* deleting so no further
                  // ChangeMessageVisibility calls race against DeleteMessage.
                  stopRenewal(pendingHandle);
                  try {
                    await sqs.send(new DeleteMessageCommand({
                      QueueUrl: config.queues.messages,
                      ReceiptHandle: pendingHandle,
                    }));
                    await clearPendingHandle(payload.botId, payload.groupJid);
                    logger.info({ key: `${payload.botId}#${payload.groupJid}` }, 'Deferred inbound message deleted (agent completed)');
                  } catch (delErr) {
                    logger.warn({ key: `${payload.botId}#${payload.groupJid}`, err: delErr }, 'Failed to delete deferred inbound message (may have expired)');
                    await clearPendingHandle(payload.botId, payload.groupJid).catch(() => {});
                  }
                }
```

- [ ] **Step 3: Type-check**

Run:
```bash
npm run typecheck -w control-plane
```

Expected: exit 0.

- [ ] **Step 4: Run all tests**

Run:
```bash
npm test -w control-plane
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/sqs/reply-consumer.ts
git commit -m "feat(control-plane): stop visibility renewal before inbound delete"
```

---

## Task 6: Write failing tests for 503 → `busy_retry` mapping in `AgentCoreInvoker`

**Files:**
- Modify: `control-plane/src/__tests__/dispatcher.test.ts` (append new test cases inside the existing `describe('invokeAgent', ...)` block)

- [ ] **Step 1: Append new test cases**

Edit `control-plane/src/__tests__/dispatcher.test.ts`. Find the last existing `it(...)` block inside `describe('invokeAgent', ...)` and append these new cases right before the closing `});` of the describe:

```ts
  it('returns busy_retry when AWS SDK rejects with a 503 RuntimeClientError', async () => {
    const err = Object.assign(
      new Error('Received error (503) from runtime. Please check your CloudWatch logs for more information.'),
      { name: 'RuntimeClientError' },
    );
    mockSend.mockRejectedValue(err);

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result.status).toBe('busy_retry');
    expect(result.result).toBeNull();
    expect(result.error).toContain('503');
  });

  it('returns busy_retry when error message carries the (503) signature even without name', async () => {
    mockSend.mockRejectedValue(new Error('Received error (503) from runtime.'));

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result.status).toBe('busy_retry');
  });

  it('still returns error (not busy_retry) for non-503 RuntimeClientError', async () => {
    const err = Object.assign(
      new Error('Received error (500) from runtime.'),
      { name: 'RuntimeClientError' },
    );
    mockSend.mockRejectedValue(err);

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result.status).toBe('error');
    expect(result.error).toContain('500');
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:
```bash
npm test -w control-plane -- dispatcher
```

Expected: the 2 new `busy_retry` cases FAIL (`Expected: "busy_retry", Received: "error"`). The `(500)` case may already pass because the current code returns `'error'` — acceptable, keep it as a regression guard.

- [ ] **Step 3: Commit the failing tests**

```bash
git add control-plane/src/__tests__/dispatcher.test.ts
git commit -m "test(control-plane): failing tests for 503 busy_retry mapping"
```

---

## Task 7: Map 503 to `busy_retry` inside `AgentCoreInvoker.invoke`

**Files:**
- Modify: `control-plane/src/sqs/dispatcher.ts:702-706`

- [ ] **Step 1: Replace the catch block**

Edit `control-plane/src/sqs/dispatcher.ts`. Find this existing block (lines 702-706):

```ts
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'AgentCore runtime invocation failed');
      return { status: 'error', result: null, error: `AgentCore invocation failed: ${message}` };
    }
```

Replace with:

```ts
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Detect the "runtime returned 503" path specifically. The AWS SDK wraps it
      // as a RuntimeClientError whose message contains "(503) from runtime".
      // In that case the microVM is busy on a previous invocation — this is a
      // re-delivery (or duplicate) we should not surface to the end user.
      const is503 = /\(503\) from runtime/i.test(message);
      if (is503) {
        logger.warn({ err }, 'AgentCore runtime busy (503), returning busy_retry');
        return {
          status: 'busy_retry',
          result: null,
          error: `AgentCore invocation failed: ${message}`,
        };
      }
      logger.error({ err }, 'AgentCore runtime invocation failed');
      return { status: 'error', result: null, error: `AgentCore invocation failed: ${message}` };
    }
```

- [ ] **Step 2: Run the tests and verify they pass**

Run:
```bash
npm test -w control-plane -- dispatcher
```

Expected: all dispatcher tests pass, including the 3 new ones from Task 6.

- [ ] **Step 3: Build to catch any type errors**

Run:
```bash
npm run build -w control-plane
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add control-plane/src/sqs/dispatcher.ts control-plane/dist/sqs
git commit -m "feat(control-plane): map AgentCore 503 to busy_retry status"
```

---

## Task 8: Suppress user-visible error in `dispatchMessage` for `busy_retry`

**Files:**
- Modify: `control-plane/src/sqs/dispatcher.ts:443-454`

- [ ] **Step 1: Replace the error branch**

Edit `control-plane/src/sqs/dispatcher.ts`. Find this existing block (lines 443-454):

```ts
    if (result.status !== 'accepted') {
      // Ack-level failure (e.g. ARN not configured, AgentCore unreachable)
      logger.error({ botId: payload.botId, status: result.status, error: result.error }, 'Agent invocation rejected');
      await sendChannelReply(
        payload.botId,
        payload.groupJid,
        payload.channelType,
        `Failed to start processing: ${result.error || `Unexpected response (status=${result.status ?? 'none'})`}`,
        logger,
        payload.replyContext,
      );
    }
```

Replace with:

```ts
    if (result.status === 'busy_retry') {
      // AgentCore microVM is busy on a previous invocation for this session
      // (almost always a SQS re-delivery while a long-running task is still
      // going). Do NOT notify the user — that original task will reply in its
      // own time. Let the SQS message's (now-renewed) visibility timeout
      // govern retry / delivery, and let touchSessionTask update the pending
      // receipt handle so reply-consumer can delete the right message later.
      logger.warn(
        { botId: payload.botId, groupJid: payload.groupJid, error: result.error },
        'Agent busy on prior invocation — suppressing user-visible error (re-delivery)',
      );
    } else if (result.status !== 'accepted') {
      // Ack-level failure (e.g. ARN not configured, AgentCore unreachable)
      logger.error({ botId: payload.botId, status: result.status, error: result.error }, 'Agent invocation rejected');
      await sendChannelReply(
        payload.botId,
        payload.groupJid,
        payload.channelType,
        `Failed to start processing: ${result.error || `Unexpected response (status=${result.status ?? 'none'})`}`,
        logger,
        payload.replyContext,
      );
    }
```

- [ ] **Step 2: Also update the scheduled-task branch at line 548 for consistency**

Edit `control-plane/src/sqs/dispatcher.ts:548-553`. Find:

```ts
  if (result.status !== 'accepted') {
    logger.error(
      { botId: payload.botId, taskId: payload.taskId, error: result.error },
      'Scheduled task invocation rejected',
    );
  }
```

Replace with:

```ts
  if (result.status === 'busy_retry') {
    logger.warn(
      { botId: payload.botId, taskId: payload.taskId, error: result.error },
      'Scheduled task found agent busy — will retry via SQS visibility timeout',
    );
  } else if (result.status !== 'accepted') {
    logger.error(
      { botId: payload.botId, taskId: payload.taskId, error: result.error },
      'Scheduled task invocation rejected',
    );
  }
```

- [ ] **Step 3: Type-check & build**

Run:
```bash
npm run typecheck -w control-plane && npm run build -w control-plane
```

Expected: exit 0.

- [ ] **Step 4: Run all tests**

Run:
```bash
npm test -w control-plane
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/sqs/dispatcher.ts control-plane/dist/sqs
git commit -m "feat(control-plane): suppress user reply on 503 busy_retry re-delivery"
```

---

## Task 9: Final verification & branch summary

- [ ] **Step 1: Run the full test suite**

Run:
```bash
npm test -w control-plane
```

Expected: every test green.

- [ ] **Step 2: Full build of workspaces touched**

Run:
```bash
npm run build -w shared && npm run build -w control-plane
```

Expected: exit 0 on both.

- [ ] **Step 3: Grep for residual references**

Run:
```bash
grep -rn "busy_retry" shared/src control-plane/src
```

Expected: definitions in `shared/src/types.ts`, `control-plane/src/sqs/dispatcher.ts`, `control-plane/src/__tests__/dispatcher.test.ts`.

Run:
```bash
grep -rn "visibility-extender\|startRenewal\|stopRenewal" control-plane/src
```

Expected: imports in `consumer.ts`, `reply-consumer.ts`; module + tests.

- [ ] **Step 4: Summarize the commits**

Run:
```bash
git log --oneline main..HEAD
```

Expected (in order):
1. `feat(shared): add 'busy_retry' status to InvocationResult`
2. `test(control-plane): failing test for visibility-extender module`
3. `feat(control-plane): add visibility-extender module for SQS renewal`
4. `feat(control-plane): renew SQS visibility while agent is running`
5. `feat(control-plane): stop visibility renewal before inbound delete`
6. `test(control-plane): failing tests for 503 busy_retry mapping`
7. `feat(control-plane): map AgentCore 503 to busy_retry status`
8. `feat(control-plane): suppress user reply on 503 busy_retry re-delivery`

---

## Testing Strategy

**Unit tests (automated):**
- `visibility-extender.test.ts` — timer lifecycle, idempotency, maxRenewals cap, error resilience (Task 2).
- `dispatcher.test.ts` — 3 new cases for 503 classification into `busy_retry` (Task 6).

**Manual / deployment verification (out of scope for this plan — tracked separately):**
- Deploy the updated control-plane image.
- Trigger a long-running agent task (>10 min) and observe:
  - `ChangeMessageVisibility` calls in the `nanoclawbot-dev-messages` queue's `ApproximateNumberOfMessagesNotVisible` staying >0 throughout the run.
  - No "Failed to start processing" replies in the chat channel.
  - A single successful final reply when the task completes.

---

## Non-Goals

- **Not** increasing the default `VisibilityTimeout` on `ReceiveMessage` (stays 600 s). The renewal loop makes that unnecessary.
- **Not** changing AgentCore session timeouts or the agent-runtime's own 503 behavior (`agent-runtime/src/server.ts:44-47`).
- **Not** persisting renewal state across control-plane restarts. On restart, SQS will re-deliver after ≤10 min, which the new 503 suppression handles cleanly.
- **Not** touching ECS-mode (`EcsTaskInvoker`) — its dispatcher path already owns task lifecycle directly.
