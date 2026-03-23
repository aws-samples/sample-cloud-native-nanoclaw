// ============================================================
// ClawBot Cloud — Channel Adapter Interfaces
// Unified abstraction for all messaging channel integrations
// ============================================================

import type { ChannelType } from './types.js';

// --- Reply Context (passed through SQS for reply routing) ---

export interface ReplyContext {
  botId: string;
  groupJid: string;
  channelType: ChannelType;
  // Discord-specific
  discordChannelId?: string;
  discordInteractionToken?: string; // slash command callback token (15min TTL)
  discordMessageId?: string;
  // Slack-specific
  slackResponseUrl?: string;
  // Feishu-specific
  feishuChatId?: string;
  feishuMessageId?: string;
  // DingTalk-specific
  dingtalkConversationId?: string;
  dingtalkMsgId?: string;
  dingtalkSessionWebhook?: string;
  dingtalkIsGroup?: boolean;
  dingtalkSenderStaffId?: string;
}

// --- Reply Options ---

export interface ReplyOptions {
  ephemeral?: boolean; // Discord slash only — hides reply from others
  format?: 'plain' | 'embed';
  replyToMessageId?: string;
  metadata?: {
    durationMs?: number;
    tokenCount?: number;
  };
}

// --- Bot Commands (Slash Commands) ---

export interface BotCommand {
  name: string;
  description: string;
  options?: BotCommandOption[];
}

export interface BotCommandOption {
  name: string;
  description: string;
  type: 'string' | 'boolean' | 'integer';
  required?: boolean;
}

// --- Channel Adapter Interface ---

export interface ChannelAdapter {
  readonly channelType: string;

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // Send reply (required — all adapters must implement)
  sendReply(ctx: ReplyContext, text: string, opts?: ReplyOptions): Promise<void>;

  // Send file (optional — adapters that support file uploads)
  sendFile?(ctx: ReplyContext, file: Buffer, fileName: string, mimeType: string, caption?: string): Promise<void>;

  // Slash commands (optional — only Discord implements initially)
  registerCommands?(botId: string, commands: BotCommand[]): Promise<void>;
  unregisterCommands?(botId: string): Promise<void>;
}
