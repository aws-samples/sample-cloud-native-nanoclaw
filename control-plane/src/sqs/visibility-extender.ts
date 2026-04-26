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

export interface RenewalOptions {
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
