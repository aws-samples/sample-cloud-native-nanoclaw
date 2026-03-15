// ClawBot Cloud — Telegram Webhook Handler
// Receives Telegram Updates, parses into unified Messages, triggers agent dispatch

import type { FastifyPluginAsync } from 'fastify';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { config } from '../config.js';
import { getChannelsByBot, putMessage, getOrCreateGroup } from '../services/dynamo.js';
import { getCachedBot, getChannelCredentials } from '../services/cached-lookups.js';
import { verifyTelegramSignature } from './signature.js';
import type { Attachment, Message, SqsInboundPayload } from '@clawbot/shared';
import { getFile } from '../channels/telegram.js';
import { downloadAndStore } from '../services/attachments.js';

const sqs = new SQSClient({ region: config.region });

// Telegram Update types (subset we care about)
interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: { file_id: string };
  video?: { file_id: string };
  video_note?: { file_id: string };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

function getTelegramSenderName(user?: TelegramUser): string {
  if (!user) return 'Unknown';
  const parts = [user.first_name];
  if (user.last_name) parts.push(user.last_name);
  return parts.join(' ');
}

function getChatName(chat: TelegramChat): string {
  return chat.title || chat.first_name || chat.username || String(chat.id);
}

function shouldTrigger(
  text: string,
  chat: TelegramChat,
  triggerPattern: string,
): boolean {
  // Private chats always trigger (no @mention needed)
  if (chat.type === 'private') return true;

  // In groups, check for trigger pattern (usually @BotName)
  if (!triggerPattern) return false;
  try {
    const regex = new RegExp(triggerPattern, 'i');
    return regex.test(text);
  } catch {
    // Fallback to simple includes check if regex is invalid
    return text.toLowerCase().includes(triggerPattern.toLowerCase());
  }
}

export const telegramWebhook: FastifyPluginAsync = async (app) => {
  // Register raw body parser for signature verification
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post<{ Params: { botId: string } }>(
    '/:botId',
    async (request, reply) => {
      const { botId } = request.params;
      const update = request.body as TelegramUpdate;
      const logger = request.log;

      try {
        // 1. Load bot config (cache -> DynamoDB)
        const bot = await getCachedBot(botId);
        if (!bot) {
          logger.warn({ botId }, 'Bot not found');
          return reply.status(200).send({ ok: true }); // 200 so Telegram doesn't retry
        }
        if (bot.status !== 'active') {
          logger.info({ botId, status: bot.status }, 'Bot not active');
          return reply.status(200).send({ ok: true });
        }

        // 2. Load channel credentials (cache -> Secrets Manager)
        const channels = await getChannelsByBot(botId);
        const telegramChannel = channels.find(
          (ch) => ch.channelType === 'telegram',
        );
        if (!telegramChannel) {
          logger.warn({ botId }, 'No Telegram channel configured for bot');
          return reply.status(200).send({ ok: true });
        }

        const creds = await getChannelCredentials(telegramChannel.credentialSecretArn);

        // 3. Verify signature header
        const rawBody =
          typeof request.body === 'string'
            ? request.body
            : JSON.stringify(request.body);
        const headers = request.headers as Record<string, string | undefined>;
        if (
          creds.webhookSecret &&
          !verifyTelegramSignature(headers, rawBody, creds.webhookSecret)
        ) {
          logger.warn({ botId }, 'Telegram signature verification failed');
          return reply.status(401).send({ error: 'Invalid signature' });
        }

        // 4. Parse Telegram Update into unified Message
        const tgMessage = update.message || update.edited_message;
        if (!tgMessage) {
          // Not a message update (could be callback_query, etc.) - ignore
          return reply.status(200).send({ ok: true });
        }

        let content = tgMessage.text || tgMessage.caption || '';
        const hasMedia = !!(tgMessage.photo || tgMessage.document || tgMessage.voice || tgMessage.video || tgMessage.video_note);

        // Voice/video: append unsupported note
        if (tgMessage.voice || tgMessage.video || tgMessage.video_note) {
          content += '\n[Voice/Video message — not yet supported]';
        }

        // Skip messages with no text and no media
        if (!content.trim() && !hasMedia) {
          return reply.status(200).send({ ok: true });
        }

        const chatId = String(tgMessage.chat.id);
        const groupJid = `tg:${chatId}`;
        const senderName = getTelegramSenderName(tgMessage.from);
        const isGroup =
          tgMessage.chat.type === 'group' ||
          tgMessage.chat.type === 'supergroup';
        const chatName = getChatName(tgMessage.chat);
        const messageId = `tg-${tgMessage.message_id}`;

        // 5. Process image/document attachments
        const attachments: Attachment[] = [];
        const botToken = creds.botToken;

        if (tgMessage.photo && tgMessage.photo.length > 0 && botToken) {
          // Take last photo (largest resolution)
          const largest = tgMessage.photo[tgMessage.photo.length - 1];
          try {
            const { filePath } = await getFile(botToken, largest.file_id);
            const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
            const fileName = filePath.split('/').pop() || 'photo.jpg';
            const att = await downloadAndStore(
              bot.userId, botId, messageId, fileUrl, fileName, 'image/jpeg',
            );
            if (att) attachments.push(att);
          } catch (err) {
            logger.warn({ err, botId }, 'Failed to download Telegram photo');
          }
        }

        if (tgMessage.document && botToken) {
          try {
            const { filePath } = await getFile(botToken, tgMessage.document.file_id);
            const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
            const fileName = tgMessage.document.file_name || filePath.split('/').pop() || 'document';
            const mimeType = tgMessage.document.mime_type || 'application/octet-stream';
            const att = await downloadAndStore(
              bot.userId, botId, messageId, fileUrl, fileName, mimeType,
            );
            if (att) attachments.push(att);
          } catch (err) {
            logger.warn({ err, botId }, 'Failed to download Telegram document');
          }
        }

        // 6. Ensure group exists in DynamoDB
        await getOrCreateGroup(botId, groupJid, chatName, 'telegram', isGroup);

        // 7. Store message in DynamoDB
        const timestamp = new Date(tgMessage.date * 1000).toISOString();
        const msg: Message = {
          botId,
          groupJid,
          timestamp,
          messageId,
          sender: String(tgMessage.from?.id || 'unknown'),
          senderName,
          content,
          isFromMe: false,
          isBotMessage: false,
          channelType: 'telegram',
          ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
          ...(attachments.length > 0 && { attachments }),
        };
        await putMessage(msg);

        // 8. Check trigger
        if (!shouldTrigger(content, tgMessage.chat, bot.triggerPattern)) {
          logger.debug({ botId, groupJid }, 'Message did not match trigger');
          return reply.status(200).send({ ok: true });
        }

        // 9. Send to SQS FIFO for agent dispatch
        const sqsPayload: SqsInboundPayload = {
          type: 'inbound_message',
          botId,
          groupJid,
          userId: bot.userId,
          messageId: msg.messageId,
          channelType: 'telegram',
          timestamp,
          ...(attachments.length > 0 && { attachments }),
        };

        await sqs.send(
          new SendMessageCommand({
            QueueUrl: config.queues.messages,
            MessageBody: JSON.stringify(sqsPayload),
            MessageGroupId: `${botId}#${groupJid}`, // FIFO ordering per group
            MessageDeduplicationId: msg.messageId,
          }),
        );

        logger.info(
          { botId, groupJid, messageId: msg.messageId },
          'Telegram message dispatched to SQS',
        );
      } catch (err) {
        logger.error(err, 'Error processing Telegram webhook');
        // Return 200 even on error to prevent Telegram from retrying indefinitely
      }

      return reply.status(200).send({ ok: true });
    },
  );
};
