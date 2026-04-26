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
    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(31_000);
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
