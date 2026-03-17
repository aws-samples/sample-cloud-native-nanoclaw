// ClawBot Cloud — WhatsApp Webhook Handler
// Handles Meta Cloud API webhooks: verification challenge + incoming messages

import type { FastifyPluginAsync } from 'fastify';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { config } from '../config.js';
import { getChannelsByBot, putMessage, getOrCreateGroup, listGroups, getUser, updateChannelHealth } from '../services/dynamo.js';
import { getCachedBot, getChannelCredentials } from '../services/cached-lookups.js';
import { verifyWhatsAppSignature } from './signature.js';
import type { Message, SqsInboundPayload } from '@clawbot/shared';

const sqs = new SQSClient({ region: config.region });

// WhatsApp Cloud API types (subset we care about)
interface WhatsAppContact {
  profile: { name: string };
  wa_id: string;
}

interface WhatsAppTextMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
}

interface WhatsAppValue {
  messaging_product: string;
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppTextMessage[];
}

interface WhatsAppChange {
  field: string;
  value: WhatsAppValue;
}

interface WhatsAppEntry {
  id: string;
  changes: WhatsAppChange[];
}

interface WhatsAppPayload {
  object: string;
  entry: WhatsAppEntry[];
}

export const whatsappWebhook: FastifyPluginAsync = async (app) => {
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

  // GET — Meta webhook verification challenge
  app.get<{
    Params: { botId: string };
    Querystring: {
      'hub.mode'?: string;
      'hub.challenge'?: string;
      'hub.verify_token'?: string;
    };
  }>(
    '/:botId',
    async (request, reply) => {
      const { botId } = request.params;
      const query = request.query;
      if (query['hub.mode'] === 'subscribe') {
        // Validate hub.verify_token against stored credentials
        const channels = await getChannelsByBot(botId);
        const whatsappChannel = channels.find(
          (ch) => ch.channelType === 'whatsapp',
        );
        if (!whatsappChannel) {
          request.log.warn({ botId }, 'No WhatsApp channel configured for bot');
          return reply.status(403).send('Forbidden');
        }

        const creds = await getChannelCredentials(whatsappChannel.credentialSecretArn);
        if (!creds.verifyToken || query['hub.verify_token'] !== creds.verifyToken) {
          request.log.warn({ botId }, 'WhatsApp verify_token mismatch');
          return reply.status(403).send('Forbidden');
        }

        // Update channel status from pending_webhook to connected
        const channelKey = `${whatsappChannel.channelType}#${whatsappChannel.channelId}`;
        await updateChannelHealth(botId, channelKey, 'healthy', 0, 'connected');
        request.log.info({ botId }, 'WhatsApp channel verified and status updated to connected');
        return reply.status(200).send(query['hub.challenge'] || '');
      }
      return reply.status(403).send('Forbidden');
    },
  );

  // POST — Incoming messages
  app.post<{ Params: { botId: string } }>(
    '/:botId',
    async (request, reply) => {
      const { botId } = request.params;
      const payload = request.body as WhatsAppPayload;
      const logger = request.log;

      try {
        // 1. Load bot config (cache -> DynamoDB)
        const bot = await getCachedBot(botId);
        if (!bot || bot.status !== 'active') {
          logger.warn({ botId }, 'Bot not found or inactive');
          return reply.status(200).send({ ok: true });
        }

        // 2. Load channel credentials (cache -> Secrets Manager)
        const channels = await getChannelsByBot(botId);
        const whatsappChannel = channels.find(
          (ch) => ch.channelType === 'whatsapp',
        );
        if (!whatsappChannel) {
          logger.warn({ botId }, 'No WhatsApp channel configured for bot');
          return reply.status(200).send({ ok: true });
        }

        const creds = await getChannelCredentials(whatsappChannel.credentialSecretArn);

        // 3. Verify HMAC-SHA256 signature
        if (creds.appSecret) {
          const rawBody = request.rawBody ?? JSON.stringify(request.body);
          const signature = (request.headers as Record<string, string | undefined>)[
            'x-hub-signature-256'
          ];
          if (
            !signature ||
            !verifyWhatsAppSignature(rawBody, signature, creds.appSecret)
          ) {
            logger.warn({ botId }, 'WhatsApp signature verification failed');
            return reply.status(401).send({ error: 'Invalid signature' });
          }
        }

        // 4. Parse Cloud API format: entry[].changes[].value.messages[]
        if (!payload.entry) {
          return reply.status(200).send({ ok: true });
        }

        for (const entry of payload.entry) {
          for (const change of entry.changes) {
            const value = change.value;
            if (!value.messages) continue;

            // Build contacts lookup for sender names
            const contactMap = new Map<string, string>();
            if (value.contacts) {
              for (const contact of value.contacts) {
                contactMap.set(contact.wa_id, contact.profile.name);
              }
            }

            for (const waMessage of value.messages) {
              // Skip non-text messages for now
              if (waMessage.type !== 'text' || !waMessage.text?.body) {
                continue;
              }

              const text = waMessage.text.body;
              if (!text.trim()) continue;

              const senderPhone = waMessage.from;
              const groupJid = `wa:${senderPhone}`;
              const senderName = contactMap.get(senderPhone) || senderPhone;

              // WhatsApp Cloud API messages are always 1:1 with the business number
              const isGroup = false;
              const chatName = `wa-${senderName}`;

              // 5. Check group quota before auto-creating
              const existingGroups = await listGroups(botId);
              const isNewGroup = !existingGroups.find(g => g.groupJid === groupJid);
              if (isNewGroup) {
                const owner = await getUser(bot.userId);
                const maxGroups = owner?.quota?.maxGroupsPerBot ?? 10;
                if (existingGroups.length >= maxGroups) {
                  logger.warn({ botId, maxGroups }, 'Group limit reached, skipping message');
                  continue;
                }
              }

              // 6. Ensure group exists in DynamoDB
              await getOrCreateGroup(botId, groupJid, chatName, 'whatsapp', isGroup);

              // 7. Store message in DynamoDB
              const timestamp = new Date(
                Number(waMessage.timestamp) * 1000,
              ).toISOString();
              const msg: Message = {
                botId,
                groupJid,
                timestamp,
                messageId: `wa-${waMessage.id}`,
                sender: senderPhone,
                senderName,
                content: text,
                isFromMe: false,
                isBotMessage: false,
                channelType: 'whatsapp',
                ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
              };
              await putMessage(msg);

              // 8. Check trigger — WhatsApp messages are always 1:1, so always trigger
              if (!shouldTrigger(text, bot.triggerPattern)) {
                logger.debug({ botId, groupJid }, 'Message did not match trigger');
                continue;
              }

              // 9. Send to SQS FIFO for agent dispatch
              const sqsPayload: SqsInboundPayload = {
                type: 'inbound_message',
                botId,
                groupJid,
                userId: bot.userId,
                messageId: msg.messageId,
                content: msg.content,
                channelType: 'whatsapp',
                timestamp,
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
                'WhatsApp message dispatched to SQS',
              );
            }
          }
        }
      } catch (err) {
        logger.error(err, 'Error processing WhatsApp webhook');
        // Return 200 even on error to prevent Meta from retrying indefinitely
      }

      return reply.status(200).send({ ok: true });
    },
  );
};

function shouldTrigger(text: string, triggerPattern: string): boolean {
  // WhatsApp messages to the business number are always direct — always trigger
  // But still check trigger pattern if one is configured
  if (!triggerPattern) return true;
  try {
    const regex = new RegExp(triggerPattern, 'i');
    return regex.test(text);
  } catch {
    return text.toLowerCase().includes(triggerPattern.toLowerCase());
  }
}
