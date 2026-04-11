// ClawBot Cloud — SQS FIFO Consumer
// Long-polls the inbound message queue and dispatches to agent processing

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import { config } from '../config.js';
import { dispatch, AgentBusyError } from './dispatcher.js';
import { setPendingDelete, getAllPendingHandles, removePendingDelete } from './pending-deletes.js';
import type { SqsPayload } from '@clawbot/shared';
import type { Logger } from 'pino';

let running = false;

/** Check if consumer is still running (used by dispatcher to abort long retries on shutdown) */
export function isConsumerRunning(): boolean { return running; }
let consumerLogger: Logger | null = null;
const sqs = new SQSClient({ region: config.region });
const cw = new CloudWatchClient({ region: config.region });

// Track in-flight message receipt handles so we can release them on shutdown
const inFlightHandles = new Set<string>();
let drainResolve: (() => void) | null = null;

// Track unique groups currently being dispatched (in-flight + pending agent reply)
// Used for the ActiveDispatchGroups CloudWatch metric that drives agent auto-scaling
const dispatchingGroups = new Set<string>();
let metricsInterval: ReturnType<typeof setInterval> | null = null;

async function publishActiveGroupsMetric(): Promise<void> {
  // Active groups = groups in dispatch/retry + groups awaiting agent reply
  const pendingGroups = getAllPendingHandles();
  const allGroups = new Set([...dispatchingGroups, ...pendingGroups.keys()]);
  try {
    await cw.send(new PutMetricDataCommand({
      Namespace: 'NanoClawBot',
      MetricData: [{
        MetricName: 'ActiveDispatchGroups',
        Value: allGroups.size,
        Unit: 'Count',
        Dimensions: [{ Name: 'Stage', Value: config.stage }],
      }],
    }));
  } catch (err) {
    consumerLogger?.debug({ err }, 'Failed to publish ActiveDispatchGroups metric');
  }
}

export function startSqsConsumer(logger: Logger): void {
  if (!config.queues.messages) {
    logger.warn('SQS_MESSAGES_URL not set, SQS consumer disabled');
    return;
  }
  running = true;
  consumerLogger = logger;
  // Publish active groups metric every 60s for agent auto-scaling.
  // Must match the CloudWatch metric period (1 min) — publishing more often
  // causes Sum statistic to double-count data points from the same replica.
  publishActiveGroupsMetric(); // seed immediately
  metricsInterval = setInterval(() => publishActiveGroupsMetric(), 60_000);
  consumeLoop(logger).catch((err) =>
    logger.error(err, 'SQS consumer crashed'),
  );
}

/**
 * Graceful stop: stop accepting new messages, wait for in-flight dispatches
 * to finish (up to timeout), then release any remaining messages back to SQS
 * by setting their visibility to 0.
 */
export async function stopSqsConsumer(timeoutMs = 15_000): Promise<void> {
  running = false;
  if (metricsInterval) { clearInterval(metricsInterval); metricsInterval = null; }
  // Publish final zero so scaling alarm sees this replica is shutting down
  publishActiveGroupsMetric().catch(() => {});
  const logger = consumerLogger;

  if (inFlightHandles.size === 0) return;

  logger?.info({ inFlight: inFlightHandles.size }, 'Waiting for in-flight dispatches to complete');

  // Wait for in-flight to drain, with timeout
  await Promise.race([
    new Promise<void>((resolve) => { drainResolve = resolve; }),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  drainResolve = null;

  // Release any still-in-flight messages back to the queue
  if (inFlightHandles.size > 0) {
    logger?.info(
      { remaining: inFlightHandles.size },
      'Releasing in-flight messages back to queue',
    );
    const releases = [...inFlightHandles].map((handle) =>
      sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: config.queues.messages,
          ReceiptHandle: handle,
          VisibilityTimeout: 0,
        }),
      ).catch(() => { /* best effort */ }),
    );
    await Promise.all(releases);
    logger?.info('In-flight messages released');
  }

  // Release pending-delete messages (dispatched to agent but not yet completed)
  const pendingHandles = getAllPendingHandles();
  if (pendingHandles.size > 0) {
    logger?.info(
      { pending: pendingHandles.size },
      'Releasing pending-delete messages back to queue',
    );
    const pendingReleases = [...pendingHandles.entries()].map(([key, handle]) =>
      sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: config.queues.messages,
          ReceiptHandle: handle,
          VisibilityTimeout: 0,
        }),
      ).then(() => removePendingDelete(key))
       .catch(() => { removePendingDelete(key); }),
    );
    await Promise.all(pendingReleases);
    logger?.info('Pending-delete messages released');
  }
}

// Simple counting semaphore for concurrency control
class Semaphore {
  private count: number;
  private readonly max: number;
  private waitQueue: Array<() => void> = [];

  constructor(max: number) {
    this.max = max;
    this.count = 0;
  }

  async acquire(): Promise<void> {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.count++;
        resolve();
      });
    });
  }

  release(): void {
    this.count--;
    const next = this.waitQueue.shift();
    if (next) next();
  }
}

async function consumeLoop(logger: Logger): Promise<void> {
  const semaphore = new Semaphore(config.maxConcurrentDispatches);

  logger.info(
    { queueUrl: config.queues.messages, maxConcurrent: config.maxConcurrentDispatches },
    'SQS consumer started',
  );

  while (running) {
    try {
      const result = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: config.queues.messages,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20, // Long-poll
          VisibilityTimeout: 600,
        }),
      );

      if (!result.Messages || result.Messages.length === 0) {
        continue;
      }

      for (let i = 0; i < result.Messages.length; i++) {
        const msg = result.Messages[i];

        // Don't start new dispatches if shutting down — release remaining batch
        if (!running) {
          for (let j = i; j < result.Messages.length; j++) {
            const h = result.Messages[j].ReceiptHandle;
            if (h && !inFlightHandles.has(h)) {
              sqs.send(new ChangeMessageVisibilityCommand({
                QueueUrl: config.queues.messages,
                ReceiptHandle: h,
                VisibilityTimeout: 0,
              })).catch(() => {});
            }
          }
          break;
        }

        await semaphore.acquire();

        const handle = msg.ReceiptHandle!;
        inFlightHandles.add(handle);

        // Track group for ActiveDispatchGroups metric
        let groupKey: string | null = null;
        try {
          const body = JSON.parse(msg.Body!) as SqsPayload;
          groupKey = `${body.botId}#${body.groupJid}`;
          dispatchingGroups.add(groupKey);
        } catch { /* parse error handled in .then */ }

        // Fire-and-forget dispatch — defer SQS delete until agent's final reply
        dispatch(msg, logger)
          .then(() => {
            // Don't delete yet — store receipt handle for deferred deletion.
            // Reply-consumer will delete when it receives isFinalReply/isError.
            // This ensures SQS FIFO blocks the next same-group message until
            // the current agent invocation completes.
            if (groupKey) {
              setPendingDelete(groupKey, handle);
              logger.debug({ key: groupKey, messageId: msg.MessageId }, 'Deferred SQS delete until agent reply');
            } else {
              // If we couldn't parse the body earlier, delete immediately to avoid blocking
              sqs.send(new DeleteMessageCommand({
                QueueUrl: config.queues.messages,
                ReceiptHandle: handle,
              })).catch(() => {});
            }
          })
          .catch((err) => {
            if (err instanceof AgentBusyError) {
              // Last resort — internal retries (~5 min) exhausted. Shorten visibility
              // so message retries from queue. This should rarely happen since auto-scaling
              // typically adds capacity within the 5-min internal retry window.
              sqs.send(new ChangeMessageVisibilityCommand({
                QueueUrl: config.queues.messages,
                ReceiptHandle: handle,
                VisibilityTimeout: 60,
              })).catch(() => {});
              logger.warn(
                { messageId: msg.MessageId },
                'All agent tasks busy after ~5min of retries, message will retry in 60s',
              );
            } else {
              logger.error(
                { err, messageId: msg.MessageId },
                'Dispatch failed, message will return to queue after visibility timeout',
              );
            }
          })
          .finally(() => {
            if (groupKey) dispatchingGroups.delete(groupKey);
            inFlightHandles.delete(handle);
            semaphore.release();
            // Signal drain if shutdown is waiting and all in-flight are done
            if (!running && inFlightHandles.size === 0 && drainResolve) {
              drainResolve();
            }
          });
      }
    } catch (err) {
      logger.error(err, 'SQS receive error');
      // Back off on receive errors to avoid tight error loops
      if (running) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  logger.info('SQS consumer stopped');
}
