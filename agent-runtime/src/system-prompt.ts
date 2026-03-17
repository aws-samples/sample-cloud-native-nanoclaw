/**
 * ClawBot Cloud — System Prompt Append Content Builder
 *
 * Builds the append content for Claude Code preset mode.
 * Claude Code natively loads CLAUDE.md files via settingSources: ['user', 'project'].
 * We append: managed policy + identity override + channel guidance + runtime metadata.
 *
 * CLAUDE.md hierarchy (loaded by Claude Code):
 *   user:    /home/node/.claude/CLAUDE.md  — bot operating manual (identity, soul, rules)
 *   project: /workspace/group/CLAUDE.md    — group conversation memory
 *
 * Append content (injected by us):
 *   1. Managed Policy  — org-level security rules (read-only, from /etc/claude-code/CLAUDE.md)
 *   2. Identity Override — "You are {botName}..." (overrides Claude Code preset identity)
 *   3. Channel Guidance — platform-specific formatting (Slack mrkdwn, Discord Markdown, etc.)
 *   4. Scheduled Task   — note for automated tasks (optional)
 *   5. Runtime Metadata — debugging info (bot, channel, group, model)
 */

import { readFileSync } from 'fs';
import type { ChannelType } from '@clawbot/shared';

// ── Managed policy (loaded once at module init) ──────────────────────────

let managedPolicy = '';
try {
  managedPolicy = readFileSync('/etc/claude-code/CLAUDE.md', 'utf-8');
} catch {
  // Fallback for local development / testing
  managedPolicy = '# Organization Policy\nNo managed policy loaded.';
}

// ── Public Interface ─────────────────────────────────────────────────────

export interface AppendOptions {
  botId: string;
  botName: string;
  channelType: ChannelType;
  groupJid: string;
  model?: string;
  isScheduledTask?: boolean;
}

/**
 * Build append content for Claude Code preset mode.
 * This is appended after the Claude Code system prompt.
 * CLAUDE.md files are loaded natively by Claude Code — not by us.
 */
export function buildAppendContent(opts: AppendOptions): string {
  const sections: string[] = [];

  // 1. Managed policy (org-level, read-only)
  sections.push(managedPolicy);

  // 2. Identity override
  sections.push(buildIdentityOverride(opts.botName));

  // 3. Channel guidance (dynamic per channel type)
  sections.push(buildChannelGuidance(opts.channelType));

  // 4. Scheduled task note (if applicable)
  if (opts.isScheduledTask) {
    sections.push(
      '**Note:** This is an automated scheduled task, not a direct user message.\n' +
      'Complete the task and report results. The user is not actively waiting for a reply.',
    );
  }

  // 5. Runtime metadata
  sections.push(buildRuntimeMetadata(opts));

  return sections.join('\n\n---\n\n');
}

// ── Section Builders ─────────────────────────────────────────────────────

function buildIdentityOverride(botName: string): string {
  return `# Identity Override
Ignore the "Claude Code" identity above. You are ${botName}, a personal AI assistant running in a messaging channel.
Your identity, personality, values, and operating rules are in ~/.claude/CLAUDE.md — follow them.`;
}

// ── Channel Guidance ─────────────────────────────────────────────────────

const CHANNEL_GUIDANCE: Partial<Record<ChannelType, string>> = {
  discord: `# Channel: Discord
You are responding on Discord.
- Use standard Markdown for formatting (bold, italic, code blocks, headers)
- Content messages have a 2000-character limit; bot embeds support up to 4096 characters
- Mention users with <@userId> format
- Use code blocks with syntax highlighting (\`\`\`language)
- Keep responses well-structured — Discord renders markdown natively
- For long responses, the system will automatically split into multiple messages`,

  telegram: `# Channel: Telegram
You are responding on Telegram.
- Use MarkdownV2 formatting (Telegram's variant, NOT standard Markdown)
- Special characters must be escaped with backslash: _ * [ ] ( ) ~ \` > # + - = | { } . !
- Bold: *text*, Italic: _text_, Code: \`code\`, Code block: \`\`\`language\\ncode\`\`\`
- Message limit is 4096 characters
- Keep messages concise — Telegram users expect chat-style brevity
- Avoid complex formatting; simple bold and code blocks work best`,

  slack: `# Channel: Slack
You are responding on Slack.
- Use Slack's mrkdwn format (NOT standard Markdown — different syntax!)
- Bold: *text* (single asterisk, not double)
- Italic: _text_
- Strikethrough: ~text~
- Code: \`code\`, Code block: \`\`\`code\`\`\`
- Links: <url|display text>
- Slack does NOT support: headings (#), standard markdown links [text](url), nested formatting
- Keep messages focused; use bullet points for lists`,

  whatsapp: `# Channel: WhatsApp
You are responding on WhatsApp.
- Use WhatsApp formatting: *bold*, _italic_, ~strikethrough~, \`code\`
- No support for code blocks with language syntax highlighting
- Message limit is 65536 characters but keep responses concise
- WhatsApp users expect conversational, brief responses
- Avoid long-form content; use short paragraphs`,
};

function buildChannelGuidance(channelType: ChannelType): string {
  return CHANNEL_GUIDANCE[channelType] || `# Channel: ${channelType}\nYou are responding on ${channelType}.`;
}

// ── Runtime Metadata ─────────────────────────────────────────────────────

function buildRuntimeMetadata(opts: AppendOptions): string {
  const parts = [
    `bot=${opts.botId}`,
    `name=${opts.botName}`,
    `channel=${opts.channelType}`,
    `group=${opts.groupJid}`,
  ];
  if (opts.model) parts.push(`model=${opts.model}`);
  return `Runtime: ${parts.join(' | ')}`;
}
