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
    (logger.info as ReturnType<typeof vi.fn>).mockReset();
    (logger.warn as ReturnType<typeof vi.fn>).mockReset();
    (logger.error as ReturnType<typeof vi.fn>).mockReset();
    (logger.debug as ReturnType<typeof vi.fn>).mockReset();
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
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ receiptHandle: expect.any(String) }),
      'SQS visibility renewal failed',
    );
  });
});
