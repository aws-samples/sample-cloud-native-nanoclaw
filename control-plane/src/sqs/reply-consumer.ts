// ClawBot Cloud — Reply Queue Consumer
// Long-polls the SQS standard reply queue for agent replies
// Routes replies back to the originating channel

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config.js';
import { getRegistry } from '../adapters/registry.js';
import { formatOutbound } from '@clawbot/shared/text-utils';
import type { ReplyContext } from '@clawbot/shared/channel-adapter';
import type { ChannelType, ModelProvider, SqsReplyPayload, SqsTextReplyPayload, ReplyMetadata } from '@clawbot/shared';
import type { Logger } from 'pino';
import {
  putMessage,
  putSession,
  updateUserUsage,
  getSession,
  clearPendingHandle,
} from '../services/dynamo.js';

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
  const s3 = new S3Client({ region: config.region });

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
            ...payload.replyContext,
          };

          if (payload.type === 'file_reply') {
            const resp = await s3.send(
              new GetObjectCommand({
                Bucket: config.s3Bucket,
                Key: payload.s3Key,
              }),
            );
            if (!resp.Body) {
              logger.error({ s3Key: payload.s3Key }, 'S3 file body is empty or missing, skipping');
              continue;
            }
            const fileBuffer = Buffer.from(
              await resp.Body.transformToByteArray(),
            );

            if (adapter.sendFile) {
              await adapter.sendFile(
                ctx,
                fileBuffer,
                payload.fileName,
                payload.mimeType,
                payload.caption,
              );
              logger.info(
                { botId: payload.botId, fileName: payload.fileName },
                'File sent via adapter',
              );
            } else {
              await adapter.sendReply(
                ctx,
                `[File: ${payload.fileName}] (file sending not supported on this channel)`,
              );
              logger.warn(
                { channelType: payload.channelType },
                'Adapter does not support sendFile, sent text fallback',
              );
            }
          } else {
            if (payload.text) {
              const formattedText = formatOutbound(payload.text);
              if (formattedText) {
                await adapter.sendReply(ctx, formattedText);
              }
            }
          }

          // Process metadata for session/usage tracking (async invocation path)
          if (payload.type === 'reply') {
            const textPayload = payload as SqsTextReplyPayload;
            if (textPayload.metadata) {
              await processReplyMetadata(
                payload.botId,
                payload.groupJid,
                payload.channelType,
                payload.text,
                payload.timestamp,
                textPayload.metadata,
                logger,
              );

              // Deferred inbound message deletion — read receipt handle from DynamoDB
              // (persisted by consumer on dispatch, survives control-plane restarts)
              if (textPayload.metadata.isFinalReply || textPayload.metadata.isError) {
                const session = await getSession(payload.botId, payload.groupJid);
                const pendingHandle = session?.pendingReceiptHandle;
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
              }
            }
          }

          // Delete reply message on success
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

async function processReplyMetadata(
  botId: string,
  groupJid: string,
  channelType: string,
  text: string,
  timestamp: string,
  meta: ReplyMetadata,
  logger: Logger,
): Promise<void> {
  try {
    // Store bot reply in DynamoDB (moved from dispatcher)
    // text is already formatted via formatOutbound() in the text reply path above
    if (meta.isFinalReply && text) {
      const senderName = meta.botName || 'bot';
      await putMessage({
        botId,
        groupJid,
        timestamp,
        messageId: `bot-${Date.now()}`,
        sender: senderName,
        senderName,
        content: text,
        isFromMe: true,
        isBotMessage: true,
        channelType: channelType as ChannelType,
        ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
      });
    }

    // Update session — also clears resetPending, since the reset intent has now
    // been consumed by a successful agent invocation. If the invocation failed
    // (no newSessionId), the flag persists so the next message still resets.
    if (meta.newSessionId) {
      await putSession({
        botId,
        groupJid,
        agentcoreSessionId: meta.newSessionId,
        s3SessionPath: meta.sessionPath || '',
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        lastModel: meta.model,
        lastModelProvider: meta.modelProvider as ModelProvider,
        resetPending: false,
      });
    }

    // Track token usage
    if (meta.tokensUsed && meta.userId) {
      await updateUserUsage(meta.userId, meta.tokensUsed).catch((err) =>
        logger.error(err, 'Failed to update user usage'),
      );
    }
  } catch (err) {
    logger.error({ err, botId, groupJid }, 'Failed to process reply metadata');
  }
}
