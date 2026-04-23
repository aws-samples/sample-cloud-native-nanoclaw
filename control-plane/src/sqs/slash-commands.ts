/**
 * Slash command parser for inbound user messages.
 *
 * Three outcomes:
 *   - `dispatcher` — Control Plane handles the command locally (no agent, no quota).
 *                    Supported: /clear, /reset, /new (all reset the SDK session);
 *                    /help (returns a static command list).
 *   - `sdk`        — Pass-through to the Claude Agent SDK with a fallback reply
 *                    if the SDK produces no text output. Supported: /context, /compact.
 *   - `unknown`    — Looks like a slash command (matches the parser regex) but is
 *                    not in any allowlist. Dispatcher replies "不支持的命令: /xxx".
 *   - `none`       — Not a slash command at all (a path like /tmp/foo.log, a message
 *                    that merely contains a slash, an empty string, etc.). Falls through
 *                    to the normal agent flow unchanged.
 *
 * A "slash command" is `/<word><end-or-whitespace-args>` anchored at the start:
 *   /clear            → command
 *   /help me          → command "help" with args "me"
 *   /tmp/foo.log      → NOT a command (the char after `tmp` is `/`, not whitespace)
 *   hello /clear      → NOT a command (does not start with `/`)
 */

export type DispatcherCommand = 'clear' | 'reset' | 'new' | 'help';
export type SdkCommand = 'context' | 'compact';

export type ParsedSlashCommand =
  | { kind: 'dispatcher'; command: DispatcherCommand; args: string }
  | { kind: 'sdk'; command: SdkCommand; args: string }
  | { kind: 'unknown'; command: string; args: string }
  | { kind: 'none' };

const DISPATCHER_CMDS = new Set<DispatcherCommand>(['clear', 'reset', 'new', 'help']);
const SDK_CMDS = new Set<SdkCommand>(['context', 'compact']);

/**
 * Capture group 1 is the command name (letters, digits, underscore, dash;
 * capped at 64 chars so a user can't amplify an echo reply or Pino log with
 * `/aaa…aaa`). Group 2 (optional) is the remainder. The critical anchor is
 * `(?:\s+…)?$` — the character immediately after the command must be
 * whitespace or end-of-string; otherwise it's a path, not a command.
 */
const SLASH_CMD_RE = /^\/([a-zA-Z][a-zA-Z0-9_-]{0,63})(?:\s+([\s\S]*))?$/;

export function parseSlashCommand(raw: string): ParsedSlashCommand {
  if (!raw) return { kind: 'none' };
  const trimmed = raw.trim();
  const match = SLASH_CMD_RE.exec(trimmed);
  if (!match) return { kind: 'none' };

  const command = match[1].toLowerCase();
  const args = (match[2] ?? '').trim();

  if (DISPATCHER_CMDS.has(command as DispatcherCommand)) {
    return { kind: 'dispatcher', command: command as DispatcherCommand, args };
  }
  if (SDK_CMDS.has(command as SdkCommand)) {
    return { kind: 'sdk', command: command as SdkCommand, args };
  }
  return { kind: 'unknown', command, args };
}

// ─── Response strings ─────────────────────────────────────────────────────────

export const REPLY_RESET = '会话已重置';

export const REPLY_HELP = [
  '可用命令：',
  '/clear · /reset · /new — 重置会话',
  '/help — 显示此帮助',
  '/context — 查看/刷新当前上下文',
  '/compact — 压缩对话历史',
].join('\n');

export const REPLY_CONTEXT_FALLBACK = '✓ 上下文信息已更新';
export const REPLY_COMPACT_FALLBACK = '✓ 对话历史已压缩';

export function replyUnknown(command: string): string {
  return `不支持的命令: /${command}`;
}
