// ClawBot Cloud — Reply Queue Consumer
// Long-polls the SQS standard reply queue for agent replies
// Routes replies back to the originating channel

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { config } from '../config.js';
import { getRegistry } from '../adapters/registry.js';
import type { ReplyContext } from '@clawbot/shared/channel-adapter';
import type { ChannelType, SqsReplyPayload } from '@clawbot/shared';
import type { Logger } from 'pino';

let running = false;

export function startReplyConsumer(logger: Logger): void {
  if (!config.queues.replies) {
    logger.warn('SQS_REPLIES_URL not set, reply consumer disabled');
    return;
  }
  running = true;
  replyLoop(logger).catch((err) =>
    logger.error(err, 'Reply consumer crashed'),
  );
}

export function stopReplyConsumer(): void {
  running = false;
}

async function replyLoop(logger: Logger): Promise<void> {
  const sqs = new SQSClient({ region: config.region });

  logger.info({ queueUrl: config.queues.replies }, 'Reply consumer started');

  while (running) {
    try {
      const result = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: config.queues.replies,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 60,
        }),
      );

      if (!result.Messages || result.Messages.length === 0) {
        continue;
      }

      for (const msg of result.Messages) {
        try {
          const payload: SqsReplyPayload = JSON.parse(msg.Body!);

          // Route reply through adapter registry
          const registry = getRegistry();
          const adapter = registry.get(payload.channelType);

          if (!adapter) {
            logger.warn(
              { botId: payload.botId, channelType: payload.channelType },
              'No adapter registered for channel type',
            );
            // Delete the message anyway to avoid infinite retries
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: config.queues.replies,
                ReceiptHandle: msg.ReceiptHandle!,
              }),
            );
            continue;
          }

          const ctx: ReplyContext = {
            botId: payload.botId,
            groupJid: payload.groupJid,
            channelType: payload.channelType as ChannelType,
          };

          if (payload.type === 'file_reply') {
            // TODO(#46): download from S3 and call adapter.sendFile
            logger.warn(
              { botId: payload.botId, groupJid: payload.groupJid },
              'file_reply not yet implemented, skipping',
            );
          } else {
            await adapter.sendReply(ctx, payload.text);
          }

          // Delete message on success
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: config.queues.replies,
              ReceiptHandle: msg.ReceiptHandle!,
            }),
          );

          logger.info(
            {
              botId: payload.botId,
              groupJid: payload.groupJid,
              channelType: payload.channelType,
            },
            'Reply delivered via channel',
          );
        } catch (err) {
          logger.error(
            { err, messageId: msg.MessageId },
            'Failed to process reply message',
          );
          // Don't delete — let visibility timeout return it to queue for retry
        }
      }
    } catch (err) {
      logger.error(err, 'Reply consumer receive error');
      if (running) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  logger.info('Reply consumer stopped');
}
