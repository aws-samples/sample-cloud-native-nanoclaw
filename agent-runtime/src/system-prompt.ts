/**
 * ClawBot Cloud — Structured System Prompt Builder
 *
 * Assembles the system prompt from a base template + dynamic sections.
 * Uses direct mode (string) instead of Claude Code preset append.
 *
 * Structure:
 *   Base template     — loaded from /app/templates/system-prompt-base.md
 *   Dynamic sections  — assembled from context files + runtime config
 *
 * Section order:
 *   [Base Template]        — Role, Tools, Tool Call Style, Context Files, Communication Style
 *   1. Identity            — "You are {botName}..."
 *   2. Identity Context    — IDENTITY.md or Bot.systemPrompt fallback
 *   3. Soul               — SOUL.md (values and behavior)
 *   4. Bootstrap           — BOOTSTRAP.md (only for new sessions)
 *   5. Channel             — Channel-specific formatting guidance
 *   6. Reply Guide         — Response conventions
 *   7. User Context        — USER.md (about the human user)
 *   8. Memory              — Shared + Bot Global + Group CLAUDE.md (with token budgets)
 *   9. Runtime             — Metadata line for debugging (includes model)
 */

import { readFileSync } from 'fs';
import type { ChannelType } from '@clawbot/shared';
import {
  loadMemoryLayers,
  loadIdentityFile,
  loadSoulFile,
  loadBootstrapFile,
  loadUserFile,
  truncateContent,
  DEFAULT_TRUNCATION,
  type TruncationConfig,
} from './memory.js';

// ── Base template (loaded once at module init) ───────────────────────────

let baseTemplate = '';
try {
  baseTemplate = readFileSync('/app/templates/system-prompt-base.md', 'utf-8');
} catch {
  // Fallback for local development / testing
  baseTemplate = '# Role\nYou are a conversational AI assistant.';
}

// ── Public Interface ──────────────────────────────────────────────────────

export interface SystemPromptOptions {
  botId: string;
  botName: string;
  channelType: ChannelType;
  groupJid: string;
  /** Bot.systemPrompt fallback when IDENTITY.md doesn't exist */
  systemPrompt?: string;
  isScheduledTask?: boolean;
  /** Controls BOOTSTRAP.md injection — true when no existing session */
  isNewSession: boolean;
  /** Current model ID for runtime metadata */
  model?: string;
  truncationConfig?: TruncationConfig;
}

/**
 * Build the complete system prompt (direct mode, not append).
 * Base template + dynamic sections joined with `---` separators.
 */
export async function buildSystemPrompt(
  opts: SystemPromptOptions,
): Promise<string> {
  const config = opts.truncationConfig ?? DEFAULT_TRUNCATION;
  const sections: string[] = [];

  // 0. Base template (Role, Tools, Context Files, Communication Style)
  sections.push(baseTemplate);

  // 1. Identity
  sections.push(buildIdentitySection(opts.botName));

  // 2. Identity Context (IDENTITY.md or Bot.systemPrompt fallback)
  const identityCtx = await buildIdentityContextSection(opts.systemPrompt, config);
  if (identityCtx) sections.push(identityCtx);

  // 3. Soul (SOUL.md)
  const soul = await buildSoulSection(config);
  if (soul) sections.push(soul);

  // 4. Bootstrap (new sessions only)
  if (opts.isNewSession) {
    const bootstrap = await buildBootstrapSection(config);
    if (bootstrap) sections.push(bootstrap);
  }

  // 5. Channel guidance
  sections.push(buildChannelGuidance(opts.channelType));

  // 6. Reply guidelines
  sections.push(buildReplyGuidelines(opts.isScheduledTask));

  // 7. User context (USER.md)
  const userCtx = await buildUserContextSection(config);
  if (userCtx) sections.push(userCtx);

  // 8. Memory layers (with token budgeting)
  const memory = await buildMemorySection(config);
  if (memory) sections.push(memory);

  // 9. Runtime metadata
  sections.push(buildRuntimeMetadata(opts));

  return sections.join('\n\n---\n\n');
}

// ── Section 1: Identity ───────────────────────────────────────────────────

function buildIdentitySection(botName: string): string {
  return `# Identity\nYou are ${botName}, a personal AI assistant.`;
}

// ── Section 2: Identity Context ───────────────────────────────────────────

async function buildIdentityContextSection(
  botSystemPrompt?: string,
  config?: TruncationConfig,
): Promise<string | null> {
  // Try IDENTITY.md first
  let identity = await loadIdentityFile();
  if (identity) {
    if (config) identity = truncateContent(identity, config.perFileCap, config);
    return `# About You\n${identity}`;
  }

  // Fall back to Bot.systemPrompt field (backward compat)
  if (botSystemPrompt) {
    return `# About You\n${botSystemPrompt}`;
  }

  return null;
}

// ── Section 3: Soul ───────────────────────────────────────────────────────

async function buildSoulSection(
  config?: TruncationConfig,
): Promise<string | null> {
  let soul = await loadSoulFile();
  if (!soul) return null;

  if (config) soul = truncateContent(soul, config.perFileCap, config);
  return `# Your Soul\nEmbody this persona and tone. Avoid stiff, generic replies; follow its guidance naturally:\n\n${soul}`;
}

// ── Section 4: Bootstrap ──────────────────────────────────────────────────

async function buildBootstrapSection(
  config?: TruncationConfig,
): Promise<string | null> {
  let bootstrap = await loadBootstrapFile();
  if (!bootstrap) return null;

  if (config) bootstrap = truncateContent(bootstrap, config.perFileCap, config);
  return `# First Session Instructions\nThis is a new conversation. Follow these initial instructions:\n\n${bootstrap}`;
}

// ── Section 5: Channel Guidance ───────────────────────────────────────────

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

// ── Section 6: Reply Guidelines ───────────────────────────────────────────

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

// ── Section 7: User Context ───────────────────────────────────────────────

async function buildUserContextSection(
  config?: TruncationConfig,
): Promise<string | null> {
  let userCtx = await loadUserFile();
  if (!userCtx) return null;

  if (config) userCtx = truncateContent(userCtx, config.perFileCap, config);
  return `# About Your User\n${userCtx}`;
}

// ── Section 8: Memory ─────────────────────────────────────────────────────

async function buildMemorySection(
  config?: TruncationConfig,
): Promise<string | null> {
  const { layers } = await loadMemoryLayers(config ?? DEFAULT_TRUNCATION);
  if (layers.length === 0) return null;

  return layers.map((l) => `${l.label}\n${l.content}`).join('\n\n---\n\n');
}

// ── Section 9: Runtime Metadata ───────────────────────────────────────────

function buildRuntimeMetadata(opts: SystemPromptOptions): string {
  const parts = [
    `bot=${opts.botId}`,
    `name=${opts.botName}`,
    `channel=${opts.channelType}`,
    `group=${opts.groupJid}`,
  ];
  if (opts.model) parts.push(`model=${opts.model}`);
  return `Runtime: ${parts.join(' | ')}`;
}
