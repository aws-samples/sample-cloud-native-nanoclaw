// ClawBot Cloud — SQS FIFO Consumer
// Long-polls the inbound message queue and dispatches to agent processing

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { config } from '../config.js';
import { dispatch } from './dispatcher.js';
import { setPendingDelete, getAllPendingHandles, removePendingDelete } from './pending-deletes.js';
import type { SqsPayload } from '@clawbot/shared';
import type { Logger } from 'pino';

let running = false;

let consumerLogger: Logger | null = null;
const sqs = new SQSClient({ region: config.region });

// Track in-flight message receipt handles so we can release them on shutdown
const inFlightHandles = new Set<string>();
let drainResolve: (() => void) | null = null;

export function startSqsConsumer(logger: Logger): void {
  if (!config.queues.messages) {
    logger.warn('SQS_MESSAGES_URL not set, SQS consumer disabled');
    return;
  }
  running = true;
  consumerLogger = logger;
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

        let groupKey: string | null = null;
        try {
          const body = JSON.parse(msg.Body!) as SqsPayload;
          groupKey = `${body.botId}#${body.groupJid}`;
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
          .catch((err) =>
            logger.error(
              { err, messageId: msg.MessageId },
              'Dispatch failed, message will return to queue after visibility timeout',
            ),
          )
          .finally(() => {
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
