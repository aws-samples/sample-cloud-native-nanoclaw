// Idle Monitor — tracks time since last invocation, exits after timeout
// Used in ECS dedicated task mode only

import type { Logger } from 'pino';

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let monitorLogger: Logger | null = null;
let timeoutMs: number;
let onTimeout: (() => Promise<void>) | null = null;

/** Start the idle monitor. Calls onTimeoutFn when idle timeout expires. */
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

/** Pause the idle timer while an invocation is in progress.
 *  Prevents long-running invocations (>15 min) from being killed mid-execution. */
export function pauseIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/** Stop the idle monitor (e.g., during graceful shutdown). */
export function stopIdleMonitor(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}
