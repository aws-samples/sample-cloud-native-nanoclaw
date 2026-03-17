// Discord Slash Commands
// Registers /ask, /status, /help commands per guild and handles interactions.

import {
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type pino from 'pino';
import { config } from '../../config.js';
import {
  putMessage,
  getOrCreateGroup,
  listGroups,
  getUser,
} from '../../services/dynamo.js';
import { getCachedBot } from '../../services/cached-lookups.js';
import type { Message, SqsInboundPayload } from '@clawbot/shared';
import { buildReplyEmbed } from './embeds.js';

const sqs = new SQSClient({ region: config.region });

// ── Command Definitions ────────────────────────────────────────────────────

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('ask')
      .setDescription('Send a question to the bot')
      .addStringOption((opt) =>
        opt.setName('prompt').setDescription('Your question').setRequired(true),
      )
      .addBooleanOption((opt) =>
        opt
          .setName('public')
          .setDescription('Show the reply to everyone (default: hidden)')
          .setRequired(false),
      ),

    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show bot status and session info'),

    new SlashCommandBuilder()
      .setName('help')
      .setDescription('List available commands and usage guide'),
  ].map((cmd) => cmd.toJSON());
}

// ── Registration ───────────────────────────────────────────────────────────

export async function registerGuildCommands(
  botToken: string,
  applicationId: string,
  guildIds: string[],
  logger: pino.Logger,
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(botToken);
  const commands = buildCommands();

  for (const guildId of guildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
        body: commands,
      });
      logger.info(
        { guildId, commandCount: commands.length },
        'Slash commands registered for guild',
      );
    } catch (err) {
      logger.error({ err, guildId }, 'Failed to register slash commands');
    }
  }
}

export async function unregisterGuildCommands(
  botToken: string,
  applicationId: string,
  guildIds: string[],
  logger: pino.Logger,
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(botToken);

  for (const guildId of guildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
        body: [],
      });
      logger.info({ guildId }, 'Slash commands cleared for guild');
    } catch (err) {
      logger.error({ err, guildId }, 'Failed to clear slash commands');
    }
  }
}

// ── Interaction Handler ────────────────────────────────────────────────────

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  botId: string,
  logger: pino.Logger,
): Promise<void> {
  const commandName = interaction.commandName;

  switch (commandName) {
    case 'ask':
      await handleAsk(interaction, botId, logger);
      break;
    case 'status':
      await handleStatus(interaction, botId, logger);
      break;
    case 'help':
      await handleHelp(interaction, logger);
      break;
    default:
      await interaction.reply({
        content: `Unknown command: /${commandName}`,
        ephemeral: true,
      });
  }
}

// ── /ask ────────────────────────────────────────────────────────────────────

async function handleAsk(
  interaction: ChatInputCommandInteraction,
  botId: string,
  logger: pino.Logger,
): Promise<void> {
  const prompt = interaction.options.getString('prompt', true);
  const isPublic = interaction.options.getBoolean('public') ?? false;

  // Defer — agent may take seconds to respond
  await interaction.deferReply({ ephemeral: !isPublic });

  const bot = await getCachedBot(botId);
  if (!bot || bot.status !== 'active') {
    await interaction.editReply('Bot is not active.');
    return;
  }

  // Slash commands use a per-user session: dc:slash:{userId}
  const userId = bot.userId;
  const groupJid = `dc:slash:${interaction.user.id}`;
  const messageId = `dc-slash-${interaction.id}`;
  const senderName = interaction.user.displayName || interaction.user.username;

  // Group quota check
  const existingGroups = await listGroups(botId);
  const isNewGroup = !existingGroups.find((g) => g.groupJid === groupJid);
  if (isNewGroup) {
    const owner = await getUser(userId);
    const maxGroups = owner?.quota?.maxGroupsPerBot ?? 10;
    if (existingGroups.length >= maxGroups) {
      await interaction.editReply('Group limit reached. Cannot create new session.');
      return;
    }
  }

  await getOrCreateGroup(botId, groupJid, `Slash: ${senderName}`, 'discord', false);

  // Store the prompt as a message
  const timestamp = new Date().toISOString();
  const msg: Message = {
    botId,
    groupJid,
    timestamp,
    messageId,
    sender: interaction.user.id,
    senderName,
    content: prompt,
    isFromMe: false,
    isBotMessage: false,
    channelType: 'discord',
    ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
  };
  await putMessage(msg);

  // Dispatch to SQS with interaction token in replyContext
  const sqsPayload: SqsInboundPayload = {
    type: 'inbound_message',
    botId,
    groupJid,
    userId,
    messageId,
    content: prompt,
    channelType: 'discord',
    timestamp,
    replyContext: {
      discordInteractionToken: interaction.token,
      discordChannelId: interaction.channelId,
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
    { botId, groupJid, messageId, command: 'ask' },
    'Slash command /ask dispatched to SQS',
  );

  // The dispatcher will call adapter.sendReply() with the interaction token,
  // which will editReply() on the deferred interaction.
  // If the agent takes too long (>15min), the token expires and dispatcher
  // falls back to channel.send().
}

// ── /status ─────────────────────────────────────────────────────────────────

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  botId: string,
  logger: pino.Logger,
): Promise<void> {
  const bot = await getCachedBot(botId);
  if (!bot) {
    await interaction.reply({ content: 'Bot not found.', ephemeral: true });
    return;
  }

  const groups = await listGroups(botId);
  const activeGroups = groups.length;

  const embed = buildReplyEmbed(
    [
      `**Bot:** ${bot.name}`,
      `**Status:** ${bot.status}`,
      `**Active Groups:** ${activeGroups}`,
      `**Trigger Pattern:** \`${bot.triggerPattern || 'none'}\``,
      `**Created:** ${new Date(bot.createdAt).toLocaleDateString()}`,
    ].join('\n'),
  );

  await interaction.reply({ embeds: [embed], ephemeral: true });
  logger.info({ botId, command: 'status' }, 'Slash command /status replied');
}

// ── /help ───────────────────────────────────────────────────────────────────

async function handleHelp(
  interaction: ChatInputCommandInteraction,
  logger: pino.Logger,
): Promise<void> {
  const embed = buildReplyEmbed(
    [
      '**Available Commands:**',
      '',
      '`/ask <prompt>` — Send a question to the bot',
      '  \u2022 `public` option: show reply to everyone',
      '',
      '`/status` — Show bot status and session info',
      '',
      '`/help` — Show this help message',
      '',
      '**Tips:**',
      '\u2022 You can also @mention the bot in any channel',
      '\u2022 DMs to the bot are always processed',
      '\u2022 Each /ask session is independent per user',
    ].join('\n'),
  );

  await interaction.reply({ embeds: [embed], ephemeral: true });
  logger.info({ command: 'help' }, 'Slash command /help replied');
}
