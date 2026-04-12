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
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}
