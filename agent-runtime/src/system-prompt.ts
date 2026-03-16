/**
 * ClawBot Cloud — Structured System Prompt Builder
 *
 * Assembles the system prompt from modular sections, inspired by OpenClaw's
 * architecture but adapted for NanoClaw's multi-tenant model.
 *
 * Section order:
 *   1. Identity       — "You are {botName}..."
 *   2. Persona        — PERSONA.md or Bot.systemPrompt fallback
 *   3. Bootstrap      — BOOTSTRAP.md (only for new sessions)
 *   4. Channel        — Channel-specific formatting guidance
 *   5. Reply Guide    — Response conventions
 *   6. User Context   — USER.md (about the humans)
 *   7. Memory         — Shared + Bot Global + Group CLAUDE.md (with token budgets)
 *   8. Runtime        — Metadata line for debugging
 *
 * Result is appended to Claude Code preset:
 *   { type: 'preset', preset: 'claude_code', append: builtContent }
 */

import type { ChannelType } from '@clawbot/shared';
import {
  loadMemoryLayers,
  loadPersonaFile,
  loadBootstrapFile,
  loadUserFile,
  truncateContent,
  DEFAULT_TRUNCATION,
  type TruncationConfig,
} from './memory.js';

// ── Public Interface ──────────────────────────────────────────────────────

export interface SystemPromptOptions {
  botId: string;
  botName: string;
  channelType: ChannelType;
  groupJid: string;
  /** Bot.systemPrompt fallback when PERSONA.md doesn't exist */
  systemPrompt?: string;
  isScheduledTask?: boolean;
  /** Controls BOOTSTRAP.md injection — true when no existing session */
  isNewSession: boolean;
  truncationConfig?: TruncationConfig;
}

/**
 * Build the complete system prompt content to append to Claude Code preset.
 * Sections are joined with `---` separators. Null sections are skipped.
 */
export async function buildSystemPrompt(
  opts: SystemPromptOptions,
): Promise<string> {
  const config = opts.truncationConfig ?? DEFAULT_TRUNCATION;
  const sections: string[] = [];

  // 1. Identity
  sections.push(buildIdentitySection(opts.botName));

  // 2. Persona (PERSONA.md or Bot.systemPrompt)
  const persona = await buildPersonaSection(opts.systemPrompt, config);
  if (persona) sections.push(persona);

  // 3. Bootstrap (new sessions only)
  if (opts.isNewSession) {
    const bootstrap = await buildBootstrapSection(config);
    if (bootstrap) sections.push(bootstrap);
  }

  // 4. Channel guidance
  sections.push(buildChannelGuidance(opts.channelType));

  // 5. Reply guidelines
  sections.push(buildReplyGuidelines(opts.isScheduledTask));

  // 6. User context (USER.md)
  const userCtx = await buildUserContextSection(config);
  if (userCtx) sections.push(userCtx);

  // 7. Memory layers (with token budgeting)
  const memory = await buildMemorySection(config);
  if (memory) sections.push(memory);

  // 8. Runtime metadata
  sections.push(buildRuntimeMetadata(opts));

  return sections.join('\n\n---\n\n');
}

// ── Section 1: Identity ───────────────────────────────────────────────────

function buildIdentitySection(botName: string): string {
  return `# Identity\nYou are ${botName}, a personal AI assistant.`;
}

// ── Section 2: Persona ────────────────────────────────────────────────────

async function buildPersonaSection(
  botSystemPrompt?: string,
  config?: TruncationConfig,
): Promise<string | null> {
  // Try PERSONA.md first
  let persona = await loadPersonaFile();
  if (persona) {
    if (config) persona = truncateContent(persona, config.perFileCap, config);
    return `# Persona\nEmbody this persona in all your interactions — adopt its identity, tone, and style:\n\n${persona}`;
  }

  // Fall back to Bot.systemPrompt field
  if (botSystemPrompt) {
    return `# Persona\n${botSystemPrompt}`;
  }

  return null;
}

// ── Section 3: Bootstrap ──────────────────────────────────────────────────

async function buildBootstrapSection(
  config?: TruncationConfig,
): Promise<string | null> {
  let bootstrap = await loadBootstrapFile();
  if (!bootstrap) return null;

  if (config) bootstrap = truncateContent(bootstrap, config.perFileCap, config);
  return `# First Session Instructions\nThis is a new conversation. Follow these initial instructions:\n\n${bootstrap}`;
}

// ── Section 4: Channel Guidance ───────────────────────────────────────────

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

// ── Section 5: Reply Guidelines ───────────────────────────────────────────

function buildReplyGuidelines(isScheduledTask?: boolean): string {
  const lines = [
    '# Reply Guidelines',
    '- Keep responses concise and focused on what was asked',
    '- Use the `send_message` MCP tool when you need to send intermediate updates or multiple messages',
    '- Do not repeat back the full question unless clarification is needed',
    '- Match the language of the user — if they write in Chinese, respond in Chinese',
  ];

  if (isScheduledTask) {
    lines.push('');
    lines.push('**Note:** This is an automated scheduled task, not a direct user message.');
    lines.push('Complete the task and report results. The user is not actively waiting for a reply.');
  }

  return lines.join('\n');
}

// ── Section 6: User Context ───────────────────────────────────────────────

async function buildUserContextSection(
  config?: TruncationConfig,
): Promise<string | null> {
  let userCtx = await loadUserFile();
  if (!userCtx) return null;

  if (config) userCtx = truncateContent(userCtx, config.perFileCap, config);
  return `# About Your Users\n${userCtx}`;
}

// ── Section 7: Memory ─────────────────────────────────────────────────────

async function buildMemorySection(
  config?: TruncationConfig,
): Promise<string | null> {
  const { layers } = await loadMemoryLayers(config ?? DEFAULT_TRUNCATION);
  if (layers.length === 0) return null;

  return layers.map((l) => `${l.label}\n${l.content}`).join('\n\n---\n\n');
}

// ── Section 8: Runtime Metadata ───────────────────────────────────────────

function buildRuntimeMetadata(opts: SystemPromptOptions): string {
  return `Runtime: bot=${opts.botId} | name=${opts.botName} | channel=${opts.channelType} | group=${opts.groupJid}`;
}
