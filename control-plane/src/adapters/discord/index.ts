// Discord Adapter
// Consolidates Gateway lifecycle, message handling, slash commands,
// embed replies, and typing indicators into the ChannelAdapter interface.

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type Message as DjsMessage,
  type Interaction,
  type TextChannel,
} from 'discord.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  GetCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type pino from 'pino';
import type { ReplyContext, ReplyOptions } from '@clawbot/shared/channel-adapter';
import type { ChannelConfig, Message, SqsInboundPayload } from '@clawbot/shared';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { BaseChannelAdapter } from '../base.js';
import { config } from '../../config.js';
import {
  getChannelsByBot,
  putMessage,
  getOrCreateGroup,
  listGroups,
  getUser,
} from '../../services/dynamo.js';
import { getCachedBot, getChannelCredentials } from '../../services/cached-lookups.js';
import { downloadAndStore } from '../../services/attachments.js';
import { formatDiscordReply } from './embeds.js';
import {
  registerGuildCommands,
  unregisterGuildCommands,
  handleSlashCommand,
} from './slash-commands.js';

// ── Constants ──────────────────────────────────────────────────────────────

const LOCK_TABLE = config.tables.sessions;
const LOCK_PK = '__system__';
const LOCK_SK = 'discord-gateway-leader';
const LOCK_TTL_S = 60;
const RENEW_INTERVAL_MS = 30_000;
const POLL_INTERVAL_MS = 30_000;
const TYPING_INTERVAL_MS = 9_000;

const INSTANCE_ID =
  process.env.ECS_TASK_ID ||
  `local-${process.pid}-${Date.now().toString(36)}`;

// ── Clients ────────────────────────────────────────────────────────────────

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: config.region }),
);
const secretsMgr = new SecretsManagerClient({ region: config.region });
const sqs = new SQSClient({ region: config.region });

// ── Types ──────────────────────────────────────────────────────────────────

interface BotGatewayInfo {
  channel: ChannelConfig;
  botDiscordId: string;
  botToken: string;
  applicationId: string;
}

// ── Discord Adapter ────────────────────────────────────────────────────────

export class DiscordAdapter extends BaseChannelAdapter {
  readonly channelType = 'discord';

  private activeTyping = new Map<string, ReturnType<typeof setInterval>>();
  private isLeader = false;
  private client: Client | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private activeBots = new Map<string, BotGatewayInfo>();

  constructor(parentLogger: pino.Logger) {
    super(parentLogger);
    this.init();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.stopped = false;

    const discordChannels = await this.discoverDiscordChannels();
    if (discordChannels.length === 0) {
      this.logger.info('No Discord channels configured, adapter idle');
      return;
    }

    this.logger.info(
      { channelCount: discordChannels.length },
      'Discord channels found, starting leader election',
    );

    const acquired = await this.tryAcquireLock();
    if (acquired) {
      await this.becomeLeader(discordChannels);
    } else {
      this.logger.info('Another instance is leader, entering standby');
      this.startStandbyPoll(discordChannels);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Clear all typing indicators
    for (const [key, timer] of this.activeTyping) {
      clearInterval(timer);
      this.activeTyping.delete(key);
    }

    if (this.client) {
      this.client.destroy();
      this.client = null;
      this.logger.info('Discord Gateway client destroyed');
    }

    if (this.isLeader) {
      await this.releaseLock();
      this.isLeader = false;
    }
  }

  // ── Send Reply ─────────────────────────────────────────────────────────

  async sendReply(
    ctx: ReplyContext,
    text: string,
    opts?: ReplyOptions,
  ): Promise<void> {
    // Stop typing indicator for this group
    const typingKey = `${ctx.botId}#${ctx.groupJid}`;
    const typingTimer = this.activeTyping.get(typingKey);
    if (typingTimer) {
      clearInterval(typingTimer);
      this.activeTyping.delete(typingKey);
    }

    if (ctx.discordInteractionToken) {
      await this.editInteractionReply(ctx, text, opts);
    } else {
      await this.sendChannelMessage(ctx, text, opts);
    }
  }

  // ── Slash Commands ─────────────────────────────────────────────────────

  async registerCommands(): Promise<void> {
    for (const [, info] of this.activeBots) {
      if (!info.applicationId) continue;

      // Collect guild IDs where this bot is present
      const guildIds = this.client
        ? Array.from(this.client.guilds.cache.keys())
        : [];

      if (guildIds.length > 0) {
        await registerGuildCommands(
          info.botToken,
          info.applicationId,
          guildIds,
          this.logger,
        );
      }
    }
  }

  async unregisterCommands(): Promise<void> {
    for (const [, info] of this.activeBots) {
      if (!info.applicationId) continue;
      const guildIds = this.client
        ? Array.from(this.client.guilds.cache.keys())
        : [];
      if (guildIds.length > 0) {
        await unregisterGuildCommands(
          info.botToken,
          info.applicationId,
          guildIds,
          this.logger,
        );
      }
    }
  }

  // ── Private: Interaction Reply ─────────────────────────────────────────

  private async editInteractionReply(
    ctx: ReplyContext,
    text: string,
    opts?: ReplyOptions,
  ): Promise<void> {
    const info = this.findBotInfo(ctx.botId);
    if (!info) {
      this.logger.error({ botId: ctx.botId }, 'No bot info for interaction reply');
      return;
    }

    const rest = new REST({ version: '10' }).setToken(info.botToken);
    const { embed, overflow } = formatDiscordReply(text, opts);

    try {
      // Edit the deferred reply
      await rest.patch(
        Routes.webhookMessage(info.applicationId, ctx.discordInteractionToken!),
        { body: { embeds: [embed.toJSON()] } },
      );

      // Send overflow as follow-up messages
      for (const chunk of overflow) {
        await rest.post(
          Routes.webhook(info.applicationId, ctx.discordInteractionToken!),
          { body: { content: chunk } },
        );
      }

      this.logger.info(
        { botId: ctx.botId, groupJid: ctx.groupJid },
        'Interaction reply sent',
      );
    } catch (err) {
      this.logger.error({ err, botId: ctx.botId }, 'Failed to edit interaction reply');
      // Fallback: try sending as regular channel message
      if (ctx.discordChannelId) {
        await this.sendChannelMessage(
          { ...ctx, discordInteractionToken: undefined },
          text,
          opts,
        );
      }
    }
  }

  // ── Private: Channel Message ───────────────────────────────────────────

  private async sendChannelMessage(
    ctx: ReplyContext,
    text: string,
    opts?: ReplyOptions,
  ): Promise<void> {
    // Try using the discord.js client first (faster, no extra REST call)
    const channelId = ctx.discordChannelId || ctx.groupJid.split(':')[1];
    if (!channelId) {
      this.logger.error({ groupJid: ctx.groupJid }, 'Cannot extract channelId');
      return;
    }

    const { embed, overflow } = formatDiscordReply(text, opts);

    if (this.client) {
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (channel && 'send' in channel) {
          await (channel as TextChannel).send({ embeds: [embed] });
          for (const chunk of overflow) {
            await (channel as TextChannel).send({ content: chunk });
          }
          this.logger.info(
            { botId: ctx.botId, groupJid: ctx.groupJid },
            'Reply sent via Gateway client',
          );
          return;
        }
      } catch {
        // Fall through to REST API
      }
    }

    // Fallback: REST API
    const info = this.findBotInfo(ctx.botId);
    if (!info) {
      // Last resort: load credentials from DynamoDB
      const channels = await getChannelsByBot(ctx.botId);
      const ch = channels.find((c) => c.channelType === 'discord');
      if (!ch) {
        this.logger.error({ botId: ctx.botId }, 'No Discord channel config');
        return;
      }
      const creds = await getChannelCredentials(ch.credentialSecretArn);
      await this.sendViaRest(creds.botToken, channelId, text);
      return;
    }

    await this.sendViaRest(info.botToken, channelId, text);
  }

  private async sendViaRest(
    botToken: string,
    channelId: string,
    text: string,
  ): Promise<void> {
    const DISCORD_API = 'https://discord.com/api/v10';
    const url = `${DISCORD_API}/channels/${channelId}/messages`;

    // Split at 2000 char boundary
    const chunks = this.splitMessage(text, 2000);
    for (const chunk of chunks) {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: chunk }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Discord sendMessage failed: ${resp.status} — ${body}`);
      }
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      let splitIdx = remaining.lastIndexOf('\n', maxLen);
      if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(' ', maxLen);
      if (splitIdx <= 0) splitIdx = maxLen;
      chunks.push(remaining.substring(0, splitIdx));
      remaining = remaining.substring(splitIdx).trimStart();
    }
    return chunks;
  }

  // ── Private: Typing Indicator ──────────────────────────────────────────

  private startTyping(botId: string, groupJid: string, channelId: string): void {
    const key = `${botId}#${groupJid}`;
    if (this.activeTyping.has(key)) return;

    const sendTyping = async () => {
      if (!this.client) return;
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (channel && 'sendTyping' in channel) {
          await (channel as TextChannel).sendTyping();
        }
      } catch {
        // Ignore typing errors
      }
    };

    sendTyping(); // Immediate first call
    const timer = setInterval(sendTyping, TYPING_INTERVAL_MS);
    this.activeTyping.set(key, timer);
  }

  // ── Private: Leader Election ───────────────────────────────────────────

  private async tryAcquireLock(): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    try {
      await ddb.send(
        new PutCommand({
          TableName: LOCK_TABLE,
          Item: {
            pk: LOCK_PK,
            sk: LOCK_SK,
            leaderId: INSTANCE_ID,
            expiresAt: now + LOCK_TTL_S,
          },
          ConditionExpression:
            'attribute_not_exists(pk) OR expiresAt < :now',
          ExpressionAttributeValues: { ':now': now },
        }),
      );
      this.logger.info({ instanceId: INSTANCE_ID }, 'Leader lock acquired');
      return true;
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        return false;
      }
      this.logger.error(err, 'Failed to acquire leader lock');
      return false;
    }
  }

  private async renewLock(): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    try {
      await ddb.send(
        new PutCommand({
          TableName: LOCK_TABLE,
          Item: {
            pk: LOCK_PK,
            sk: LOCK_SK,
            leaderId: INSTANCE_ID,
            expiresAt: now + LOCK_TTL_S,
          },
          ConditionExpression: 'leaderId = :me',
          ExpressionAttributeValues: { ':me': INSTANCE_ID },
        }),
      );
      return true;
    } catch {
      this.logger.warn('Failed to renew leader lock, stepping down');
      return false;
    }
  }

  private async releaseLock(): Promise<void> {
    try {
      await ddb.send(
        new DeleteCommand({
          TableName: LOCK_TABLE,
          Key: { pk: LOCK_PK, sk: LOCK_SK },
          ConditionExpression: 'leaderId = :me',
          ExpressionAttributeValues: { ':me': INSTANCE_ID },
        }),
      );
      this.logger.info('Leader lock released');
    } catch {
      // Already expired or taken
    }
  }

  private async isLockExpired(): Promise<boolean> {
    try {
      const res = await ddb.send(
        new GetCommand({
          TableName: LOCK_TABLE,
          Key: { pk: LOCK_PK, sk: LOCK_SK },
        }),
      );
      if (!res.Item) return true;
      return (res.Item.expiresAt as number) < Math.floor(Date.now() / 1000);
    } catch {
      return true;
    }
  }

  // ── Private: Leader Lifecycle ──────────────────────────────────────────

  private async becomeLeader(discordChannels: ChannelConfig[]): Promise<void> {
    this.isLeader = true;
    this.activeBots = new Map();

    for (const ch of discordChannels) {
      try {
        const creds = await this.loadCredentials(ch.credentialSecretArn);
        // Fetch application ID for slash commands
        let applicationId = '';
        try {
          const me = await this.fetchBotUser(creds.botToken);
          applicationId = me.id; // Bot user ID is the application ID
        } catch {
          this.logger.warn({ botId: ch.botId }, 'Could not fetch application ID');
        }

        this.activeBots.set(ch.botId, {
          channel: ch,
          botDiscordId: ch.channelId,
          botToken: creds.botToken,
          applicationId,
        });
      } catch (err) {
        this.logger.error({ err, botId: ch.botId }, 'Failed to load Discord credentials');
      }
    }

    if (this.activeBots.size === 0) {
      this.logger.warn('No valid Discord bot tokens, staying leader but idle');
      this.startRenewLoop();
      return;
    }

    const firstBot = this.activeBots.values().next().value!;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.on(Events.ClientReady, (c) => {
      this.logger.info(
        { tag: c.user.tag, userId: c.user.id, guilds: c.guilds.cache.size },
        'Discord Gateway connected',
      );
      for (const [, info] of this.activeBots) {
        info.botDiscordId = c.user.id;
        if (!info.applicationId) info.applicationId = c.user.id;
      }
      // Register slash commands on ready
      this.registerCommands().catch((err) =>
        this.logger.error(err, 'Failed to register slash commands'),
      );
    });

    this.client.on(Events.MessageCreate, (message: DjsMessage) => {
      this.handleMessage(message).catch((err) =>
        this.logger.error({ err, messageId: message.id }, 'Error handling message'),
      );
    });

    this.client.on(Events.InteractionCreate, (interaction: Interaction) => {
      if (!interaction.isChatInputCommand()) return;
      const botInfo = this.findBotForInteraction();
      if (!botInfo) return;

      handleSlashCommand(interaction, botInfo.channel.botId, this.logger).catch(
        (err) =>
          this.logger.error({ err }, 'Error handling slash command'),
      );
    });

    this.client.on(Events.Error, (err) => {
      this.logger.error({ err }, 'Discord client error');
    });

    try {
      await this.client.login(firstBot.botToken);
    } catch (err) {
      this.logger.error(err, 'Failed to login to Discord Gateway');
      this.isLeader = false;
      await this.releaseLock();
      return;
    }

    this.startRenewLoop();
  }

  // ── Private: Message Handler ───────────────────────────────────────────

  private async handleMessage(message: DjsMessage): Promise<void> {
    if (message.author.bot) return;

    let content = message.content;
    const hasAttachments = message.attachments.size > 0;
    if (!content.trim() && !hasAttachments) return;

    const botInfo = this.findBotForMessage(message);
    if (!botInfo) return;

    const botId = botInfo.channel.botId;
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

    const bot = await getCachedBot(botId);
    if (!bot || bot.status !== 'active') return;

    // @mention translation
    const isBotMentioned =
      message.mentions.users.has(botInfo.botDiscordId) ||
      content.includes(`<@${botInfo.botDiscordId}>`) ||
      content.includes(`<@!${botInfo.botDiscordId}>`);

    if (isBotMentioned) {
      content = content
        .replace(new RegExp(`<@!?${botInfo.botDiscordId}>`, 'g'), '')
        .trim();
    }

    // Trigger check: DMs always trigger; guild messages require @mention or pattern
    if (isGroup && !isBotMentioned) {
      const pattern = bot.triggerPattern;
      if (!pattern) return;
      try {
        if (!new RegExp(pattern, 'i').test(content)) return;
      } catch {
        if (!content.toLowerCase().includes(pattern.toLowerCase())) return;
      }
    }

    this.logger.info(
      {
        author: message.author.tag,
        channelId,
        guildId: message.guildId,
        isGroup,
        isBotMentioned,
      },
      'Discord message processing',
    );

    // Start typing indicator
    this.startTyping(botId, groupJid, channelId);

    // Process attachments
    const attachments: import('@clawbot/shared').Attachment[] = [];
    for (const [, da] of message.attachments) {
      const ct = da.contentType || '';
      if (ct.startsWith('audio/') || ct.startsWith('video/')) {
        content += '\n[Voice/Video message — not yet supported]';
        continue;
      }
      if (
        ct.startsWith('image/') ||
        ct.startsWith('application/') ||
        ct.startsWith('text/')
      ) {
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
          this.logger.warn({ err, botId }, 'Failed to download attachment');
        }
      }
    }

    // Group quota check
    const existingGroups = await listGroups(botId);
    const isNewGroup = !existingGroups.find((g) => g.groupJid === groupJid);
    if (isNewGroup) {
      const owner = await getUser(bot.userId);
      const maxGroups = owner?.quota?.maxGroupsPerBot ?? 10;
      if (existingGroups.length >= maxGroups) {
        this.logger.warn({ botId, maxGroups }, 'Group limit reached');
        return;
      }
    }

    await getOrCreateGroup(botId, groupJid, chatName, 'discord', isGroup);

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

    this.logger.info(
      { botId, groupJid, messageId: msg.messageId },
      'Discord message dispatched to SQS',
    );
  }

  // ── Private: Standby / Renew ───────────────────────────────────────────

  private startRenewLoop(): void {
    this.renewTimer = setInterval(async () => {
      if (this.stopped) return;
      const ok = await this.renewLock();
      if (!ok) {
        this.logger.warn('Lost leader lock, disconnecting');
        if (this.client) {
          this.client.destroy();
          this.client = null;
        }
        this.isLeader = false;
        const channels = await this.discoverDiscordChannels();
        if (channels.length > 0 && !this.stopped) {
          this.startStandbyPoll(channels);
        }
      }
    }, RENEW_INTERVAL_MS);
  }

  private startStandbyPoll(discordChannels: ChannelConfig[]): void {
    this.pollTimer = setInterval(async () => {
      if (this.stopped) return;
      const expired = await this.isLockExpired();
      if (expired) {
        this.logger.info('Leader lock expired, attempting takeover');
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        const acquired = await this.tryAcquireLock();
        if (acquired) {
          const freshChannels = await this.discoverDiscordChannels();
          await this.becomeLeader(freshChannels);
        } else {
          this.startStandbyPoll(discordChannels);
        }
      }
    }, POLL_INTERVAL_MS);
  }

  // ── Private: Helpers ───────────────────────────────────────────────────

  private findBotForMessage(message: DjsMessage): BotGatewayInfo | undefined {
    for (const [, info] of this.activeBots) {
      if (this.client?.user?.id === info.botDiscordId) return info;
    }
    return this.activeBots.values().next().value;
  }

  private findBotForInteraction(): BotGatewayInfo | undefined {
    return this.activeBots.values().next().value;
  }

  private findBotInfo(botId: string): BotGatewayInfo | undefined {
    return this.activeBots.get(botId) || this.activeBots.values().next().value;
  }

  private async discoverDiscordChannels(): Promise<ChannelConfig[]> {
    const result = await ddb.send(
      new ScanCommand({
        TableName: config.tables.channels,
        FilterExpression: 'channelType = :ct',
        ExpressionAttributeValues: { ':ct': 'discord' },
      }),
    );
    return (result.Items || []) as ChannelConfig[];
  }

  private async loadCredentials(
    secretArn: string,
  ): Promise<Record<string, string>> {
    const res = await secretsMgr.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    return JSON.parse(res.SecretString || '{}');
  }

  private async fetchBotUser(
    botToken: string,
  ): Promise<{ id: string; username: string }> {
    const resp = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!resp.ok) throw new Error(`Discord /users/@me failed: ${resp.status}`);
    return (await resp.json()) as { id: string; username: string };
  }
}
