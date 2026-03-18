// Discord — Shared message handler
// Used by both Gateway adapter (messageCreate event) and legacy webhook fallback.
// Single source of truth for: attachment processing, trigger check, DynamoDB store, SQS dispatch.

import type { Message as DjsMessage, TextChannel } from 'discord.js';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type pino from 'pino';
import { config } from '../config.js';
import {
  putMessage,
  getOrCreateGroup,
  listGroups,
  getUser,
} from '../services/dynamo.js';
import { getCachedBot } from '../services/cached-lookups.js';
import { downloadAndStore } from '../services/attachments.js';
import type { Attachment, Message, SqsInboundPayload } from '@clawbot/shared';

const sqs = new SQSClient({ region: config.region });

export interface HandleMessageOpts {
  message: DjsMessage;
  botId: string;
  botDiscordId: string;
  logger: pino.Logger;
  onProcessing?: (groupJid: string) => void;
}

export async function handleDiscordMessage({
  message,
  botId,
  botDiscordId,
  logger,
  onProcessing,
}: HandleMessageOpts): Promise<void> {
  // Ignore bot messages (including own)
  if (message.author.bot) return;

  let content = message.content;
  const hasAttachments = message.attachments.size > 0;

  if (!content.trim() && !hasAttachments) return;

  const channelId = message.channelId;
  const groupJid = `dc:${channelId}`;
  const messageId = `dc-${message.id}`;
  const isGroup = !!message.guild;
  const senderName =
    message.member?.displayName ||
    message.author.displayName ||
    message.author.username;

  let chatName: string;
  if (message.guild) {
    const textChannel = message.channel as TextChannel;
    chatName = `${message.guild.name} #${textChannel.name}`;
  } else {
    chatName = senderName;
  }

  // Load bot config
  const bot = await getCachedBot(botId);
  if (!bot || bot.status !== 'active') return;

  // @mention translation: <@botUserId> -> trigger text
  const isBotMentioned =
    message.mentions.users.has(botDiscordId) ||
    content.includes(`<@${botDiscordId}>`) ||
    content.includes(`<@!${botDiscordId}>`);

  if (isBotMentioned) {
    content = content
      .replace(new RegExp(`<@!?${botDiscordId}>`, 'g'), '')
      .trim();
  }

  // Check trigger: DMs always trigger; guild messages require @mention or trigger pattern
  if (isGroup && !isBotMentioned) {
    const pattern = bot.triggerPattern;
    if (!pattern) return;
    try {
      if (!new RegExp(pattern, 'i').test(content)) return;
    } catch {
      if (!content.toLowerCase().includes(pattern.toLowerCase())) return;
    }
  }

  logger.info(
    {
      botId,
      channelId,
      contentLength: content.length,
      attachmentCount: message.attachments.size,
      attachmentNames: hasAttachments ? [...message.attachments.values()].map(a => a.name) : [],
    },
    'Discord message processing',
  );

  // Signal that validation passed — caller can start typing indicator etc.
  onProcessing?.(groupJid);

  // Process attachments
  const attachments: Attachment[] = [];
  for (const [, da] of message.attachments) {
    const ct = da.contentType || 'application/octet-stream';
    logger.info({ botId, name: da.name, contentType: da.contentType, size: da.size }, 'Processing Discord attachment');
    if (ct.startsWith('audio/') || ct.startsWith('video/')) {
      content += '\n[Voice/Video message — not yet supported]';
      continue;
    }
    try {
      const att = await downloadAndStore(
        bot.userId,
        botId,
        messageId,
        da.url,
        da.name,
        ct,
      );
      if (att) attachments.push(att);
    } catch (err) {
      logger.warn({ err, botId, name: da.name }, 'Failed to download Discord attachment');
    }
  }

  // Append attachment info to content so agent knows what files are available
  if (attachments.length > 0) {
    const fileDescs = attachments.map((a) => `- ${a.fileName || a.s3Key.split('/').pop()} (${a.mimeType})`).join('\n');
    content += `\n[Attached files — saved to /workspace/group/attachments/]\n${fileDescs}`;
  }

  // Group quota check
  const existingGroups = await listGroups(botId);
  const isNewGroup = !existingGroups.find((g) => g.groupJid === groupJid);
  if (isNewGroup) {
    const owner = await getUser(bot.userId);
    const maxGroups = owner?.quota?.maxGroupsPerBot ?? 10;
    if (existingGroups.length >= maxGroups) {
      logger.warn({ botId, maxGroups }, 'Group limit reached, skipping');
      return;
    }
  }

  // Ensure group exists
  await getOrCreateGroup(botId, groupJid, chatName, 'discord', isGroup);

  // Store message
  const timestamp = message.createdAt.toISOString();
  const msg: Message = {
    botId,
    groupJid,
    timestamp,
    messageId,
    sender: message.author.id,
    senderName,
    content,
    isFromMe: false,
    isBotMessage: false,
    channelType: 'discord',
    ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
    ...(attachments.length > 0 && { attachments }),
  };
  await putMessage(msg);

  // Dispatch to SQS
  const sqsPayload: SqsInboundPayload = {
    type: 'inbound_message',
    botId,
    groupJid,
    userId: bot.userId,
    messageId: msg.messageId,
    content: msg.content,
    channelType: 'discord',
    timestamp,
    ...(attachments.length > 0 && { attachments }),
    replyContext: {
      discordChannelId: channelId,
    },
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
    { botId, groupJid, messageId: msg.messageId, channelId },
    'Discord message dispatched to SQS',
  );
}
