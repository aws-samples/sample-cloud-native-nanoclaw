// ClawBot Cloud — Feishu/Lark Webhook Handler
// Receives Feishu Event v2.0 payloads, parses into unified Messages, triggers agent dispatch

import type { FastifyPluginAsync } from 'fastify';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { config } from '../config.js';
import { getChannelsByBot, putMessage, getOrCreateGroup, listGroups, getUser, updateChannelHealth } from '../services/dynamo.js';
import { getCachedBot, getChannelCredentials } from '../services/cached-lookups.js';
import { verifyFeishuSignature } from './signature.js';
import type { Attachment, Message, SqsInboundPayload } from '@clawbot/shared';
import { downloadFeishuResource } from '../channels/feishu.js';
import { storeFromBuffer } from '../services/attachments.js';
import type { FeishuDomain } from '../channels/feishu.js';

const sqs = new SQSClient({ region: config.region });

// ── Feishu Event v2.0 types ─────────────────────────────────────────────────

interface FeishuUrlVerification {
  type: 'url_verification';
  challenge: string;
  token: string;
}

interface FeishuEventHeader {
  event_id: string;
  event_type: string;
  create_time: string;
  token: string;
  app_id: string;
  tenant_key: string;
}

interface FeishuSenderId {
  open_id: string;
  user_id?: string;
  union_id?: string;
}

interface FeishuSender {
  sender_id: FeishuSenderId;
  sender_type: string;
  tenant_key?: string;
}

interface FeishuMention {
  key: string;
  id: string;
  id_type: string;
  name: string;
}

interface FeishuMessageEvent {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  create_time: string;
  chat_id: string;
  chat_type: 'p2p' | 'group';
  message_type: string; // text, image, file, audio, rich_text, etc.
  content: string; // JSON string
  mentions?: FeishuMention[];
}

interface FeishuImMessageEvent {
  sender: FeishuSender;
  message: FeishuMessageEvent;
}

interface FeishuEventCallback {
  schema: string;
  header: FeishuEventHeader;
  event: FeishuImMessageEvent;
}

type FeishuPayload = FeishuUrlVerification | FeishuEventCallback;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Strip @bot mentions from Feishu text content.
 * Rich text format: <at user_id="ou_xxx">BotName</at>
 * Plain text format: @_user_N (where N is a number)
 */
function stripAtMentions(text: string): string {
  // Rich text format
  let cleaned = text.replace(/<at user_id="[^"]*">[^<]*<\/at>/g, '');
  // Plain text format
  cleaned = cleaned.replace(/@_user_\d+/g, '');
  return cleaned.trim();
}

/**
 * Check if the bot was @mentioned in a group message.
 * Uses the structured mentions array from Feishu events, matching on the bot's open_id.
 */
function isBotMentioned(mentions: FeishuMention[] | undefined, botOpenId: string): boolean {
  if (!mentions || !botOpenId) return false;
  return mentions.some(m => m.id === botOpenId);
}

function shouldTrigger(
  text: string,
  chatType: 'p2p' | 'group',
  triggerPattern: string,
  mentions: FeishuMention[] | undefined,
  botOpenId: string,
): boolean {
  // Private (p2p) chats always trigger
  if (chatType === 'p2p') return true;

  // In groups, check if bot was @mentioned
  if (isBotMentioned(mentions, botOpenId)) return true;

  // Check trigger pattern
  if (!triggerPattern) return false;
  try {
    const regex = new RegExp(triggerPattern, 'i');
    return regex.test(text);
  } catch {
    return text.toLowerCase().includes(triggerPattern.toLowerCase());
  }
}

/**
 * Parse Feishu message content JSON and extract text.
 * Text messages: { "text": "@_user_1 hello" }
 * Rich text messages: { "title": "...", "content": [[{ "tag": "text", "text": "..." }]] }
 */
function parseFeishuContent(messageType: string, contentJson: string): string {
  try {
    const parsed = JSON.parse(contentJson);

    if (messageType === 'text') {
      return parsed.text || '';
    }

    if (messageType === 'rich_text') {
      // rich_text has nested content arrays: [[{ tag: "text", text: "..." }, ...]]
      const lines: string[] = [];
      const title = parsed.title;
      if (title) lines.push(title);

      const content = parsed.content;
      if (Array.isArray(content)) {
        for (const line of content) {
          if (Array.isArray(line)) {
            const lineText = line
              .filter((el: { tag: string }) => el.tag === 'text' || el.tag === 'a')
              .map((el: { text?: string; href?: string }) => el.text || el.href || '')
              .join('');
            if (lineText) lines.push(lineText);
          }
        }
      }
      return lines.join('\n');
    }

    // For image/file/audio types, return empty — handled separately
    return '';
  } catch {
    return '';
  }
}

/**
 * Determine MIME type from Feishu message_type.
 */
function mimeTypeForFeishuMessage(messageType: string): string {
  switch (messageType) {
    case 'image':
      return 'image/png';
    case 'audio':
      return 'audio/opus';
    case 'file':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Sanitize file name before using it in S3 keys.
 * Removes path separators and traversal sequences, truncates long names.
 */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\]/g, '_')     // Remove path separators
    .replace(/\.\./g, '_')      // Remove path traversal
    .slice(0, 200);             // Truncate long names
}

// ── Webhook Plugin ──────────────────────────────────────────────────────────

export const feishuWebhook: FastifyPluginAsync = async (app) => {
  // Register raw body parser for signature verification
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      // Store raw body for signature verification before parsing
      req.rawBody = body as string;
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
      const body = request.body as FeishuPayload;
      const logger = request.log;

      try {
        // 1. Handle url_verification challenge (Feishu setup handshake)
        if ('type' in body && body.type === 'url_verification') {
          const verification = body as FeishuUrlVerification;
          logger.info({ botId }, 'Feishu URL verification challenge received');

          // Update channel status from pending_webhook to connected
          const channels = await getChannelsByBot(botId);
          const feishuCh = channels.find(c => c.channelType === 'feishu');
          if (feishuCh) {
            const channelKey = `${feishuCh.channelType}#${feishuCh.channelId}`;
            await updateChannelHealth(botId, channelKey, 'healthy', 0, 'connected');
            logger.info({ botId }, 'Feishu channel status updated to connected (webhook verified)');
          }

          return reply.status(200).send({
            challenge: verification.challenge,
          });
        }

        // 2. Load bot config (cache -> DynamoDB)
        const bot = await getCachedBot(botId);
        if (!bot) {
          logger.warn({ botId }, 'Bot not found');
          return reply.status(200).send({ ok: true });
        }
        if (bot.status !== 'active') {
          logger.info({ botId, status: bot.status }, 'Bot not active');
          return reply.status(200).send({ ok: true });
        }

        // 3. Load channel credentials (cache -> Secrets Manager)
        const channels = await getChannelsByBot(botId);
        const feishuChannel = channels.find(
          (ch) => ch.channelType === 'feishu',
        );
        if (!feishuChannel) {
          logger.warn({ botId }, 'No Feishu channel configured for bot');
          return reply.status(200).send({ ok: true });
        }

        const creds = await getChannelCredentials(feishuChannel.credentialSecretArn);

        // 4. Verify signature
        if (creds.encryptKey) {
          const rawBody = request.rawBody ?? JSON.stringify(request.body);
          const headers = request.headers as Record<string, string | undefined>;
          const timestamp = headers['x-lark-request-timestamp'] || '';
          const nonce = headers['x-lark-request-nonce'] || '';
          const signature = headers['x-lark-signature'] || '';

          if (!verifyFeishuSignature(timestamp, nonce, creds.encryptKey, rawBody, signature)) {
            logger.warn({ botId }, 'Feishu signature verification failed');
            return reply.status(200).send({ ok: true }); // 200 to prevent retries
          }
        }

        // 5. Only handle im.message.receive_v1 events
        const eventPayload = body as FeishuEventCallback;
        if (!eventPayload.header || eventPayload.header.event_type !== 'im.message.receive_v1') {
          return reply.status(200).send({ ok: true });
        }

        const event = eventPayload.event;
        if (!event || !event.message) {
          return reply.status(200).send({ ok: true });
        }

        const feishuMsg = event.message;
        const sender = event.sender;

        // Filter out bot's own messages to prevent infinite loops
        if (sender.sender_type === 'bot') {
          return reply.status(200).send({ ok: true });
        }

        // Parse message content
        const rawContent = parseFeishuContent(feishuMsg.message_type, feishuMsg.content);
        let content = stripAtMentions(rawContent);
        const hasMedia = ['image', 'file', 'audio'].includes(feishuMsg.message_type);

        // Audio: append unsupported note
        if (feishuMsg.message_type === 'audio') {
          content += '\n[Voice message — not yet supported]';
        }

        // Skip messages with no text and no media
        if (!content.trim() && !hasMedia) {
          return reply.status(200).send({ ok: true });
        }

        const chatId = feishuMsg.chat_id;
        const groupJid = `feishu#${chatId}`;
        const isGroup = feishuMsg.chat_type === 'group';
        const chatName = isGroup ? `feishu-group-${chatId}` : `feishu-dm-${sender.sender_id.open_id}`;
        const messageId = feishuMsg.message_id;

        // 6. Process image/file attachments
        const attachments: Attachment[] = [];
        const appId = creds.appId;
        const appSecret = creds.appSecret;
        const domain = (creds.domain as FeishuDomain) || 'feishu';

        if (appId && appSecret && (feishuMsg.message_type === 'image' || feishuMsg.message_type === 'file')) {
          try {
            // Extract file_key from content JSON
            const contentParsed = JSON.parse(feishuMsg.content);
            const fileKey = contentParsed.image_key || contentParsed.file_key;
            const fileName = sanitizeFileName(contentParsed.file_name || `${feishuMsg.message_type}_${Date.now()}`);
            const mimeType = mimeTypeForFeishuMessage(feishuMsg.message_type);
            const resourceType = feishuMsg.message_type === 'image' ? 'image' as const : 'file' as const;

            if (fileKey) {
              const data = await downloadFeishuResource(
                appId, appSecret, messageId, fileKey, domain, resourceType,
              );
              const att = await storeFromBuffer(
                bot.userId, botId, messageId, data, fileName, mimeType,
              );
              if (att) attachments.push(att);
            }
          } catch (err) {
            logger.warn({ err, botId }, 'Failed to download Feishu attachment');
          }
        }

        // 7. Check group quota before auto-creating
        const existingGroups = await listGroups(botId);
        const isNewGroup = !existingGroups.find(g => g.groupJid === groupJid);
        if (isNewGroup) {
          const owner = await getUser(bot.userId);
          const maxGroups = owner?.quota?.maxGroupsPerBot ?? 10;
          if (existingGroups.length >= maxGroups) {
            logger.warn({ botId, maxGroups }, 'Group limit reached, skipping message');
            return reply.status(200).send({ ok: true });
          }
        }

        // 7b. Append attachment info so agent knows what files are available
        if (attachments.length > 0) {
          const fileDescs = attachments.map((a) => `- ${a.fileName || a.s3Key.split('/').pop()} (${a.mimeType})`).join('\n');
          content += `\n[Attached files — saved to /workspace/group/attachments/]\n${fileDescs}`;
        }

        // 8. Ensure group exists in DynamoDB
        await getOrCreateGroup(botId, groupJid, chatName, 'feishu', isGroup);

        // 9. Store message in DynamoDB
        const createTimeMs = Number(feishuMsg.create_time);
        const timestamp = createTimeMs > 0
          ? new Date(createTimeMs).toISOString()
          : new Date().toISOString();
        const msg: Message = {
          botId,
          groupJid,
          timestamp,
          messageId,
          sender: sender.sender_id.open_id,
          senderName: sender.sender_id.open_id, // Feishu doesn't include display name in events
          content,
          isFromMe: false,
          isBotMessage: false,
          channelType: 'feishu',
          ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
          ...(attachments.length > 0 && { attachments }),
        };
        await putMessage(msg);

        // 10. Check trigger (use mentions array for bot detection, raw content for pattern matching)
        if (!shouldTrigger(rawContent, feishuMsg.chat_type, bot.triggerPattern, feishuMsg.mentions, creds.botOpenId)) {
          logger.debug({ botId, groupJid }, 'Message did not match trigger');
          return reply.status(200).send({ ok: true });
        }

        // 11. Send to SQS FIFO for agent dispatch
        const sqsPayload: SqsInboundPayload = {
          type: 'inbound_message',
          botId,
          groupJid,
          userId: bot.userId,
          messageId: msg.messageId,
          content: msg.content,
          channelType: 'feishu',
          timestamp,
          ...(attachments.length > 0 && { attachments }),
          replyContext: {
            feishuChatId: chatId,
            feishuMessageId: messageId,
          },
        };

        await sqs.send(
          new SendMessageCommand({
            QueueUrl: config.queues.messages,
            MessageBody: JSON.stringify(sqsPayload),
            MessageGroupId: `${botId}#${groupJid}`,
            MessageDeduplicationId: messageId,
          }),
        );

        logger.info(
          { botId, groupJid, messageId: msg.messageId },
          'Feishu message dispatched to SQS',
        );
      } catch (err) {
        logger.error(err, 'Error processing Feishu webhook');
        // Return 200 even on error to prevent Feishu from retrying indefinitely
      }

      return reply.status(200).send({ ok: true });
    },
  );
};
