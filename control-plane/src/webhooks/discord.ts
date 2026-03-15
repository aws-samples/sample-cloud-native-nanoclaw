// ClawBot Cloud — Discord Webhook Handler
// Handles Discord Interactions (PING + MESSAGE_CREATE events via gateway webhook)

import type { FastifyPluginAsync } from 'fastify';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { config } from '../config.js';
import { getChannelsByBot, putMessage, getOrCreateGroup } from '../services/dynamo.js';
import { getCachedBot, getChannelCredentials } from '../services/cached-lookups.js';
import { verifyDiscordSignature } from './signature.js';
import type { Attachment, Message, SqsInboundPayload } from '@clawbot/shared';
import { downloadAndStore } from '../services/attachments.js';

const sqs = new SQSClient({ region: config.region });

// Discord interaction types
const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;

// Discord event types for gateway webhook forwarding
interface DiscordInteraction {
  type: number;
  id: string;
  token?: string;
  data?: Record<string, unknown>;
  // Gateway event fields (when forwarded from a gateway webhook)
  t?: string; // event name
  d?: DiscordMessageEvent;
}

interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  global_name?: string;
}

interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size: number;
  url: string;
  proxy_url: string;
}

interface DiscordMessageEvent {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  content: string;
  timestamp: string;
  mentions?: DiscordUser[];
  attachments?: DiscordAttachment[];
}

function getDiscordDisplayName(user: DiscordUser): string {
  return user.global_name || user.username;
}

function shouldTrigger(
  content: string,
  mentions: DiscordUser[] | undefined,
  guildId: string | undefined,
  triggerPattern: string,
  botDiscordId?: string,
): boolean {
  // DMs (no guild) always trigger
  if (!guildId) return true;

  // Check if bot was @mentioned
  if (botDiscordId && mentions?.some((m) => m.id === botDiscordId)) {
    return true;
  }

  // Check trigger pattern regex
  if (!triggerPattern) return false;
  try {
    const regex = new RegExp(triggerPattern, 'i');
    return regex.test(content);
  } catch {
    return content.toLowerCase().includes(triggerPattern.toLowerCase());
  }
}

export const discordWebhook: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { botId: string } }>(
    '/:botId',
    async (request, reply) => {
      const { botId } = request.params;
      const body = request.body as DiscordInteraction;
      const logger = request.log;

      try {
        // 1. Handle PING interaction (Discord verification handshake)
        if (body.type === INTERACTION_PING) {
          logger.info({ botId }, 'Discord PING received, responding with PONG');
          return reply.status(200).send({ type: 1 }); // PONG
        }

        // 2. Load bot config
        const bot = await getCachedBot(botId);
        if (!bot) {
          logger.warn({ botId }, 'Bot not found');
          return reply.status(200).send({ ok: true });
        }
        if (bot.status !== 'active') {
          logger.info({ botId, status: bot.status }, 'Bot not active');
          return reply.status(200).send({ ok: true });
        }

        // 3. Load channel credentials and verify signature
        const channels = await getChannelsByBot(botId);
        const discordChannel = channels.find(
          (ch) => ch.channelType === 'discord',
        );
        if (!discordChannel) {
          logger.warn({ botId }, 'No Discord channel configured for bot');
          return reply.status(200).send({ ok: true });
        }

        const creds = await getChannelCredentials(discordChannel.credentialSecretArn);

        // Verify Ed25519 signature
        if (creds.publicKey) {
          const rawBody =
            typeof request.body === 'string'
              ? request.body
              : JSON.stringify(request.body);
          const headers = request.headers as Record<
            string,
            string | undefined
          >;
          const valid = await verifyDiscordSignature(
            headers,
            rawBody,
            creds.publicKey,
          );
          if (!valid) {
            logger.warn({ botId }, 'Discord signature verification failed');
            return reply.status(401).send({ error: 'Invalid signature' });
          }
        }

        // 4. Handle gateway MESSAGE_CREATE events
        const messageEvent = body.d;
        if (!messageEvent || body.t !== 'MESSAGE_CREATE') {
          // Handle application commands or other interaction types
          if (body.type === INTERACTION_APPLICATION_COMMAND) {
            logger.info({ botId }, 'Application command received (not yet supported)');
            return reply.status(200).send({
              type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
              data: { content: 'Command received.' },
            });
          }
          return reply.status(200).send({ ok: true });
        }

        // Skip bot messages
        if (messageEvent.author.id === creds.applicationId) {
          return reply.status(200).send({ ok: true });
        }

        let content = messageEvent.content;
        const discordAttachments = messageEvent.attachments || [];
        const hasAttachments = discordAttachments.length > 0;

        if (!content.trim() && !hasAttachments) {
          return reply.status(200).send({ ok: true });
        }

        const channelId = messageEvent.channel_id;
        const groupJid = `dc:${channelId}`;
        const isGroup = !!messageEvent.guild_id;
        const chatName = isGroup
          ? `discord-${messageEvent.guild_id}-${channelId}`
          : `dm-${messageEvent.author.username}`;
        const messageId = `dc-${messageEvent.id}`;

        // 5. Process attachments
        const attachments: Attachment[] = [];
        for (const da of discordAttachments) {
          const ct = da.content_type || '';
          // Voice/video: append unsupported note
          if (ct.startsWith('audio/') || ct.startsWith('video/')) {
            content += '\n[Voice/Video message — not yet supported]';
            continue;
          }
          // Image or document — download and store
          if (ct.startsWith('image/') || ct.startsWith('application/') || ct.startsWith('text/')) {
            try {
              const att = await downloadAndStore(
                bot.userId, botId, messageId, da.url, da.filename, ct,
              );
              if (att) attachments.push(att);
            } catch (err) {
              logger.warn({ err, botId }, 'Failed to download Discord attachment');
            }
          }
        }

        // 6. Ensure group exists
        await getOrCreateGroup(botId, groupJid, chatName, 'discord', isGroup);

        // 7. Store message
        const timestamp = messageEvent.timestamp || new Date().toISOString();
        const msg: Message = {
          botId,
          groupJid,
          timestamp,
          messageId,
          sender: messageEvent.author.id,
          senderName: getDiscordDisplayName(messageEvent.author),
          content,
          isFromMe: false,
          isBotMessage: false,
          channelType: 'discord',
          ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
          ...(attachments.length > 0 && { attachments }),
        };
        await putMessage(msg);

        // 8. Check trigger
        if (
          !shouldTrigger(
            content,
            messageEvent.mentions,
            messageEvent.guild_id,
            bot.triggerPattern,
            creds.applicationId,
          )
        ) {
          return reply.status(200).send({ ok: true });
        }

        // 9. Dispatch to SQS
        const sqsPayload: SqsInboundPayload = {
          type: 'inbound_message',
          botId,
          groupJid,
          userId: bot.userId,
          messageId: msg.messageId,
          channelType: 'discord',
          timestamp,
          ...(attachments.length > 0 && { attachments }),
        };

        await sqs.send(
          new SendMessageCommand({
            QueueUrl: config.queues.messages,
            MessageBody: JSON.stringify(sqsPayload),
            MessageGroupId: `${botId}#${groupJid}`,
            MessageDeduplicationId: msg.messageId,
          }),
        );

        logger.info(
          { botId, groupJid, messageId: msg.messageId },
          'Discord message dispatched to SQS',
        );
      } catch (err) {
        logger.error(err, 'Error processing Discord webhook');
      }

      return reply.status(200).send({ ok: true });
    },
  );
};
