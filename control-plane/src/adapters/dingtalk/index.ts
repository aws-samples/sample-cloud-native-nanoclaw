// DingTalk Channel Adapter
// Manages DingTalk Stream (WebSocket) gateway connections for inbound messages.
// Uses DingTalk REST API for outbound replies, with sessionWebhook fast-path.
// Leader election is handled internally by DingTalkGatewayManager.

import { BaseChannelAdapter } from '../base.js';
import type { ReplyContext, ReplyOptions } from '@clawbot/shared/channel-adapter';
import {
  getAccessToken,
  sendMarkdownMessage,
  replyGroupMarkdownMessage,
} from '../../channels/dingtalk.js';
import {
  initDingTalkGatewayManager,
  getDingTalkGatewayManager,
} from '../../dingtalk/gateway-manager.js';
import { getChannelsByBot } from '../../services/dynamo.js';
import { getChannelCredentials } from '../../services/cached-lookups.js';

// ── Constants ────────────────────────────────────────────────────────────────

const DINGTALK_MAX_CHARS = 4000;
const DINGTALK_WEBHOOK_URL_PREFIX = 'https://oapi.dingtalk.com/';

// ── Helper: DingTalk sessionWebhook allows direct reply without API token ──

async function sendViaSessionWebhook(
  webhookUrl: string,
  text: string,
): Promise<void> {
  // Validate URL to prevent SSRF
  if (!webhookUrl.startsWith(DINGTALK_WEBHOOK_URL_PREFIX)) {
    throw new Error(`Invalid session webhook URL: must start with ${DINGTALK_WEBHOOK_URL_PREFIX}`);
  }

  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'markdown',
      markdown: { title: 'Reply', text },
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '(could not read body)');
    throw new Error(`Session webhook failed: ${resp.status} ${resp.statusText} — ${body}`);
  }
}

// ── Message Chunking ─────────────────────────────────────────────────────────

/**
 * Split text into chunks of up to maxLen characters.
 * Avoids splitting in the middle of fenced code blocks (``` ... ```).
 * Falls back to splitting at newlines, then at spaces, then hard-cut.
 */
function chunkMarkdownText(text: string, maxLen = DINGTALK_MAX_CHARS): string[] {
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
    const candidate = remaining.slice(0, splitAt);
    const fenceMatches = candidate.match(/```/g);
    const fenceCount = fenceMatches ? fenceMatches.length : 0;

    if (fenceCount % 2 !== 0) {
      // We are inside a code block — find the opening ``` and split before it
      const lastFenceIdx = candidate.lastIndexOf('```');
      if (lastFenceIdx > 0) {
        const beforeFence = candidate.slice(0, lastFenceIdx);
        const newlineIdx = beforeFence.lastIndexOf('\n');
        splitAt = newlineIdx > 0 ? newlineIdx : lastFenceIdx;
      }
    }

    // If splitAt is still at maxLen, try to split at a natural boundary
    if (splitAt === maxLen) {
      const segment = remaining.slice(0, splitAt);
      const newlineIdx = segment.lastIndexOf('\n');
      if (newlineIdx > maxLen * 0.3) {
        splitAt = newlineIdx;
      } else {
        const spaceIdx = segment.lastIndexOf(' ');
        if (spaceIdx > maxLen * 0.3) {
          splitAt = spaceIdx;
        }
      }
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class DingTalkAdapter extends BaseChannelAdapter {
  readonly channelType = 'dingtalk';

  constructor(parentLogger: import('pino').Logger) {
    super(parentLogger);
    this.init();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Initialize the gateway manager (handles leader election internally)
    initDingTalkGatewayManager(this.logger);
    const gw = getDingTalkGatewayManager();
    if (gw) await gw.start();
  }

  async stop(): Promise<void> {
    const gw = getDingTalkGatewayManager();
    if (gw) await gw.stopAll();
  }

  // ── Send Reply ──────────────────────────────────────────────────────────

  async sendReply(
    ctx: ReplyContext,
    text: string,
    _opts?: ReplyOptions,
  ): Promise<void> {
    // Load channel config for this bot
    const channels = await getChannelsByBot(ctx.botId);
    const channel = channels.find((ch) => ch.channelType === 'dingtalk');
    if (!channel) {
      this.logger.warn(
        { botId: ctx.botId },
        'No DingTalk channel configured for bot',
      );
      return;
    }

    // Load credentials from Secrets Manager (cached)
    const creds = await getChannelCredentials(channel.credentialSecretArn);
    const clientId = creds.clientId;
    const clientSecret = creds.clientSecret;

    if (!clientId || !clientSecret) {
      this.logger.error(
        { botId: ctx.botId },
        'Missing clientId or clientSecret in DingTalk credentials',
      );
      return;
    }

    // Get access token
    const token = await getAccessToken(clientId, clientSecret);
    const robotCode = clientId; // robotCode === clientId in DingTalk

    // Determine conversation ID and message type
    const conversationId =
      ctx.dingtalkConversationId || ctx.groupJid.replace(/^dt:/, '');
    const isGroup = ctx.dingtalkIsGroup ?? false;

    // Split long messages into chunks
    const chunks = chunkMarkdownText(text);

    for (const chunk of chunks) {
      // Try sessionWebhook first (fastest path for group replies)
      if (ctx.dingtalkSessionWebhook) {
        try {
          await sendViaSessionWebhook(ctx.dingtalkSessionWebhook, chunk);
          this.logger.info(
            { botId: ctx.botId, groupJid: ctx.groupJid },
            'DingTalk reply sent via session webhook',
          );
          continue;
        } catch (err) {
          this.logger.warn(
            { err, botId: ctx.botId },
            'DingTalk session webhook failed, falling back to API',
          );
          // Fall through to API path
        }
      }

      // Send via DingTalk API (Markdown format preferred)
      if (isGroup) {
        await replyGroupMarkdownMessage(
          token,
          conversationId,
          'Reply',
          chunk,
          robotCode,
        );
      } else {
        // DM: oToMessages/batchSend requires userIds, not conversationId
        const senderStaffId = ctx.dingtalkSenderStaffId || ctx.groupJid.replace(/^dt:/, '');
        await sendMarkdownMessage(
          token,
          [senderStaffId],
          'Reply',
          chunk,
          robotCode,
        );
      }

      this.logger.info(
        { botId: ctx.botId, groupJid: ctx.groupJid, isGroup },
        'DingTalk reply sent',
      );
    }
  }

  // sendFile — DingTalk media upload API not yet implemented (P1 feature).
  // For now, send the file name as text.
  async sendFile(
    ctx: ReplyContext,
    _file: Buffer,
    fileName: string,
    _mimeType: string,
    caption?: string,
  ): Promise<void> {
    const text = caption ? `${caption}\n[File: ${fileName}]` : `[File: ${fileName}]`;
    await this.sendReply(ctx, text);
  }
}
