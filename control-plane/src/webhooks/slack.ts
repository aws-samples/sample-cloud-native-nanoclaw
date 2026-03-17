// ClawBot Cloud — Slack Webhook Handler
// Handles Slack Events API: url_verification, event_callback (message events)

import type { FastifyPluginAsync } from 'fastify';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { config } from '../config.js';
import { getChannelsByBot, putMessage, getOrCreateGroup, listGroups, getUser, updateChannelHealth } from '../services/dynamo.js';
import { getCachedBot, getChannelCredentials } from '../services/cached-lookups.js';
import { verifySlackSignature } from './signature.js';
import type { Attachment, Message, SqsInboundPayload } from '@clawbot/shared';
import { downloadAndStore } from '../services/attachments.js';

const sqs = new SQSClient({ region: config.region });

// Slack event types
interface SlackUrlVerification {
  type: 'url_verification';
  challenge: string;
  token: string;
}

interface SlackEventCallback {
  type: 'event_callback';
  team_id: string;
  event: SlackMessageEvent;
  event_id: string;
  event_time: number;
}

interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  size: number;
  url_private: string;
}

interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel: string;
  channel_type?: string; // 'im' for DMs, 'channel'/'group' for channels
  user?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  files?: SlackFile[];
}

type SlackPayload = SlackUrlVerification | SlackEventCallback;

function shouldTrigger(
  text: string,
  channelType: string | undefined,
  triggerPattern: string,
  slackBotUserId?: string,
): boolean {
  // DMs always trigger
  if (channelType === 'im') return true;

  // Check if bot was @mentioned in channel
  if (slackBotUserId && text.includes(`<@${slackBotUserId}>`)) {
    return true;
  }

  // Check trigger pattern
  if (!triggerPattern) return false;
  try {
    const regex = new RegExp(triggerPattern, 'i');
    return regex.test(text);
  } catch {
    return text.toLowerCase().includes(triggerPattern.toLowerCase());
  }
}

function slackTsToIso(ts: string): string {
  // Slack timestamps are Unix epoch with microseconds: "1234567890.123456"
  const epochSeconds = parseFloat(ts);
  return new Date(epochSeconds * 1000).toISOString();
}

export const slackWebhook: FastifyPluginAsync = async (app) => {
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
      const body = request.body as SlackPayload;
      const logger = request.log;

      try {
        // 1. Handle url_verification challenge (Slack setup handshake)
        if (body.type === 'url_verification') {
          const verification = body as SlackUrlVerification;
          logger.info({ botId }, 'Slack URL verification challenge received');

          // Update channel status from pending_webhook to connected
          const channels = await getChannelsByBot(botId);
          const slackChannel = channels.find(c => c.channelType === 'slack');
          if (slackChannel) {
            const channelKey = `${slackChannel.channelType}#${slackChannel.channelId}`;
            await updateChannelHealth(botId, channelKey, 'healthy', 0, 'connected');
            logger.info({ botId }, 'Slack channel status updated to connected (webhook verified)');
          }

          return reply.status(200).send({
            challenge: verification.challenge,
          });
        }

        // 2. Handle event_callback
        if (body.type !== 'event_callback') {
          return reply.status(200).send({ ok: true });
        }

        const eventPayload = body as SlackEventCallback;
        const event = eventPayload.event;

        // Only handle message events (not subtypes like message_changed, bot_message)
        if (event.type !== 'message' || event.subtype || event.bot_id) {
          return reply.status(200).send({ ok: true });
        }

        // 3. Load bot config
        const bot = await getCachedBot(botId);
        if (!bot) {
          logger.warn({ botId }, 'Bot not found');
          return reply.status(200).send({ ok: true });
        }
        if (bot.status !== 'active') {
          logger.info({ botId, status: bot.status }, 'Bot not active');
          return reply.status(200).send({ ok: true });
        }

        // 4. Load channel credentials and verify signature
        const channels = await getChannelsByBot(botId);
        const slackChannel = channels.find(
          (ch) => ch.channelType === 'slack',
        );
        if (!slackChannel) {
          logger.warn({ botId }, 'No Slack channel configured for bot');
          return reply.status(200).send({ ok: true });
        }

        const creds = await getChannelCredentials(slackChannel.credentialSecretArn);

        // Verify Slack signature
        if (creds.signingSecret) {
          const rawBody = request.rawBody ?? JSON.stringify(request.body);
          const headers = request.headers as Record<
            string,
            string | undefined
          >;
          if (!verifySlackSignature(headers, rawBody, creds.signingSecret)) {
            logger.warn({ botId }, 'Slack signature verification failed');
            return reply.status(401).send({ error: 'Invalid signature' });
          }
        }

        // 5. Parse message
        let content = event.text || '';
        const slackFiles = event.files || [];
        const hasFiles = slackFiles.length > 0;

        if (!content.trim() && !hasFiles) {
          return reply.status(200).send({ ok: true });
        }

        const slackChannelId = event.channel;
        const groupJid = `sl:${slackChannelId}`;
        const isGroup = event.channel_type !== 'im';
        const chatName = isGroup
          ? `slack-${eventPayload.team_id}-${slackChannelId}`
          : `dm-${event.user || 'unknown'}`;
        const messageId = `sl-${event.ts.replace('.', '-')}`;

        // 6. Process file attachments
        const attachments: Attachment[] = [];
        const bearerToken = creds.botToken;

        for (const sf of slackFiles) {
          const mime = sf.mimetype || '';
          // Voice/video: append unsupported note
          if (mime.startsWith('audio/') || mime.startsWith('video/')) {
            content += '\n[Voice/Video message — not yet supported]';
            continue;
          }
          // Image or document — download and store (Slack requires Bearer auth)
          if (mime.startsWith('image/') || mime.startsWith('application/') || mime.startsWith('text/')) {
            try {
              const authHeaders = bearerToken
                ? { Authorization: `Bearer ${bearerToken}` }
                : undefined;
              const att = await downloadAndStore(
                bot.userId, botId, messageId, sf.url_private, sf.name, mime, authHeaders,
              );
              if (att) attachments.push(att);
            } catch (err) {
              logger.warn({ err, botId }, 'Failed to download Slack file');
            }
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

        // 8. Ensure group exists
        await getOrCreateGroup(botId, groupJid, chatName, 'slack', isGroup);

        // 9. Store message
        const timestamp = slackTsToIso(event.ts);
        const msg: Message = {
          botId,
          groupJid,
          timestamp,
          messageId,
          sender: event.user || 'unknown',
          senderName: event.user || 'Unknown', // Slack doesn't include display name in events
          content,
          isFromMe: false,
          isBotMessage: false,
          channelType: 'slack',
          ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
          ...(attachments.length > 0 && { attachments }),
        };
        await putMessage(msg);

        // 10. Check trigger
        if (
          !shouldTrigger(
            content,
            event.channel_type,
            bot.triggerPattern,
            creds.botUserId,
          )
        ) {
          return reply.status(200).send({ ok: true });
        }

        // 11. Dispatch to SQS
        const sqsPayload: SqsInboundPayload = {
          type: 'inbound_message',
          botId,
          groupJid,
          userId: bot.userId,
          messageId: msg.messageId,
          content: msg.content,
          channelType: 'slack',
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
          'Slack message dispatched to SQS',
        );
      } catch (err) {
        logger.error(err, 'Error processing Slack webhook');
      }

      return reply.status(200).send({ ok: true });
    },
  );
};
