// Feishu/Lark Channel Adapter
// Thin wrapper around the existing Feishu channel client.
// Feishu uses webhooks for inbound — start/stop are no-ops.
// Sends card messages (markdown) with fallback to plain text.

import { BaseChannelAdapter } from '../base.js';
import type { ReplyContext, ReplyOptions } from '@clawbot/shared/channel-adapter';
import {
  sendFeishuMessage,
  sendFeishuCardMessage,
  replyFeishuMessage,
} from '../../channels/feishu.js';
import type { FeishuDomain } from '../../channels/feishu.js';
import { getChannelsByBot } from '../../services/dynamo.js';
import { getChannelCredentials } from '../../services/cached-lookups.js';

// ── Text Chunking ──────────────────────────────────────────────────────────

const FEISHU_MAX_CHARS = 4000;

/**
 * Split text into chunks of up to maxLen characters.
 * Avoids splitting in the middle of fenced code blocks (``` ... ```).
 * Falls back to splitting at newlines, then at spaces, then hard-cut.
 */
function chunkMarkdownText(text: string, maxLen = FEISHU_MAX_CHARS): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = maxLen;

    // Check if we would split inside a fenced code block.
    // Count ``` occurrences in the candidate chunk.
    const candidate = remaining.slice(0, splitAt);
    const fenceMatches = candidate.match(/```/g);
    const fenceCount = fenceMatches ? fenceMatches.length : 0;

    if (fenceCount % 2 !== 0) {
      // We are inside a code block — find the opening ``` and split before it
      const lastFenceIdx = candidate.lastIndexOf('```');
      if (lastFenceIdx > 0) {
        // Try to split at a newline just before the code block
        const beforeFence = candidate.slice(0, lastFenceIdx);
        const newlineIdx = beforeFence.lastIndexOf('\n');
        splitAt = newlineIdx > 0 ? newlineIdx : lastFenceIdx;
      }
    }

    // If splitAt is still at maxLen, try to split at a natural boundary
    if (splitAt === maxLen) {
      const segment = remaining.slice(0, splitAt);
      // Prefer splitting at the last newline
      const newlineIdx = segment.lastIndexOf('\n');
      if (newlineIdx > maxLen * 0.3) {
        splitAt = newlineIdx;
      } else {
        // Try splitting at last space
        const spaceIdx = segment.lastIndexOf(' ');
        if (spaceIdx > maxLen * 0.3) {
          splitAt = spaceIdx;
        }
        // Otherwise hard-cut at maxLen
      }
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, ''); // trim leading newline from next chunk
  }

  return chunks;
}

// ── Card Builder ───────────────────────────────────────────────────────────

function buildCard(markdownContent: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'ClawBot' },
      template: 'blue',
    },
    elements: [{ tag: 'markdown', content: markdownContent }],
  };
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu';

  constructor(parentLogger: import('pino').Logger) {
    super(parentLogger);
    this.init();
  }

  async start(): Promise<void> {
    // Feishu uses webhook-based ingestion — no gateway to connect
  }

  async stop(): Promise<void> {
    // Nothing to tear down
  }

  async sendReply(
    ctx: ReplyContext,
    text: string,
    _opts?: ReplyOptions,
  ): Promise<void> {
    try {
      // Load channel config for this bot
      const channels = await getChannelsByBot(ctx.botId);
      const channel = channels.find((ch) => ch.channelType === 'feishu');
      if (!channel) {
        this.logger.warn(
          { botId: ctx.botId },
          'No Feishu channel configured for bot',
        );
        return;
      }

      // Load credentials from Secrets Manager (cached)
      const creds = await getChannelCredentials(channel.credentialSecretArn);
      const appId = creds.appId;
      const appSecret = creds.appSecret;
      const domain = (creds.domain as FeishuDomain) || 'feishu';

      if (!appId || !appSecret) {
        this.logger.error(
          { botId: ctx.botId },
          'Missing appId or appSecret in Feishu credentials',
        );
        return;
      }

      // Extract chat ID: prefer explicit feishuChatId, fall back to groupJid parsing
      const chatId =
        ctx.feishuChatId || ctx.groupJid.replace(/^feishu#/, '');
      if (!chatId) {
        this.logger.error(
          { groupJid: ctx.groupJid },
          'Could not extract chatId from groupJid',
        );
        return;
      }

      // Split long messages into chunks
      const chunks = chunkMarkdownText(text);

      for (const chunk of chunks) {
        // For group replies with a message ID, use reply API
        if (ctx.feishuMessageId) {
          try {
            await replyFeishuMessage(
              appId,
              appSecret,
              ctx.feishuMessageId,
              chunk,
              domain,
            );
            // Only reply to the first chunk; subsequent chunks are sent as new messages
            ctx = { ...ctx, feishuMessageId: undefined };
            continue;
          } catch (err) {
            this.logger.warn(
              { err, botId: ctx.botId },
              'Feishu reply failed, falling back to send',
            );
            // Fall through to send as new message
          }
        }

        // Try card message first, fall back to plain text
        try {
          const card = buildCard(chunk);
          await sendFeishuCardMessage(appId, appSecret, chatId, card, domain);
        } catch (cardErr) {
          this.logger.warn(
            { err: cardErr, botId: ctx.botId },
            'Feishu card message failed, falling back to plain text',
          );
          await sendFeishuMessage(appId, appSecret, chatId, chunk, domain);
        }
      }

      this.logger.info(
        { botId: ctx.botId, groupJid: ctx.groupJid, chunks: chunks.length },
        'Feishu reply sent',
      );
    } catch (err) {
      this.logger.error(
        { err, botId: ctx.botId, groupJid: ctx.groupJid },
        'Failed to send Feishu reply',
      );
    }
  }

  async sendFile(
    ctx: ReplyContext,
    _file: Buffer,
    fileName: string,
    _mimeType: string,
    caption?: string,
  ): Promise<void> {
    try {
      // Feishu file upload API requires creating a file resource first,
      // which adds complexity. For now, send caption text with file info.
      const text = caption
        ? `${caption}\n\n[File: ${fileName}]`
        : `[File: ${fileName}]`;

      await this.sendReply(ctx, text);

      this.logger.info(
        { botId: ctx.botId, groupJid: ctx.groupJid, fileName },
        'Feishu file placeholder sent',
      );
    } catch (err) {
      this.logger.error(
        { err, botId: ctx.botId, groupJid: ctx.groupJid, fileName },
        'Failed to send file via Feishu',
      );
    }
  }
}
