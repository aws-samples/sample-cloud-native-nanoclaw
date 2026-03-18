/**
 * ClawBot Cloud — Agent Invocation Handler
 *
 * Cloud equivalent of NanoClaw's container/agent-runner/src/index.ts.
 * Key differences from NanoClaw:
 *   1. Input comes from HTTP body (InvocationPayload), not stdin
 *   2. Output returned as HTTP response (InvocationResult), not stdout markers
 *   3. S3 sync replaces Docker volume mounts
 *   4. MCP tools call AWS SDK instead of writing IPC files
 *   5. CLAUDE_CODE_USE_BEDROCK=1 for Bedrock Claude
 *   6. No IPC message loop — single invocation per HTTP request
 *
 * Preserves NanoClaw patterns:
 *   - Claude Agent SDK query() with same tool allowlist
 *   - MCP server for clawbot tools (send_message, schedule_task, etc.)
 *   - Native CLAUDE.md memory (bot-level ~/.claude/ + group-level /workspace/group/)
 *   - Pre-compact hook for conversation archiving
 *   - Session resumption via sessionId
 */

import fs, { rmSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import type pino from 'pino';
import type { InvocationPayload, InvocationResult } from '@clawbot/shared';
import { syncFromS3, syncToS3, type SyncPaths } from './session.js';
import { buildAppendContent } from './system-prompt.js';
import { getScopedClients } from './scoped-credentials.js';
import { setBusy, setIdle } from './server.js';

const SESSION_BUCKET = process.env.SESSION_BUCKET || '';
const DEFAULT_MODEL = 'global.anthropic.claude-sonnet-4-6';

// Session switch detection — track which bot+group we last served
let currentSessionKey: string | undefined;

async function cleanLocalWorkspace(): Promise<void> {
  for (const dir of ['/workspace/group', '/workspace/learnings', '/workspace/reference', '/home/node/.claude']) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Main invocation handler
// ---------------------------------------------------------------------------

export async function handleInvocation(
  payload: InvocationPayload,
  logger: pino.Logger,
): Promise<InvocationResult> {
  setBusy();
  try {
    return await _handleInvocation(payload, logger);
  } finally {
    setIdle();
  }
}

async function _handleInvocation(
  payload: InvocationPayload,
  logger: pino.Logger,
): Promise<InvocationResult> {
  const { botId, botName, groupJid, userId, prompt, sessionPath, memoryPaths } = payload;

  // Session switch detection — clean workspace if serving a different bot/group
  const sessionKey = `${botId}#${groupJid}`;
  if (currentSessionKey && currentSessionKey !== sessionKey) {
    logger.info(
      { previousSession: currentSessionKey, newSession: sessionKey },
      'Session switch detected, cleaning local workspace',
    );
    await cleanLocalWorkspace();
  }
  currentSessionKey = sessionKey;

  // 1. Get scoped credentials (STS ABAC — userId + botId tags)
  logger.info({ botId, userId }, 'Acquiring scoped credentials');
  const scopedClients = await getScopedClients(userId, botId);

  // Also create an S3 client with the scoped credentials for session sync
  const s3 = scopedClients.s3;

  // 2. Sync session and memory from S3 → local workspace
  const syncPaths: SyncPaths = {
    sessionPath,
    botClaude: memoryPaths.botClaude,
    groupPrefix: memoryPaths.groupPrefix,
    learningsPrefix: memoryPaths.learnings,
  };

  logger.info({ sessionPath, groupJid }, 'Syncing session from S3');
  await syncFromS3(s3, SESSION_BUCKET, syncPaths, logger);

  // 3. Copy bot operating manual to ~/.claude/CLAUDE.md if not present (first run)
  const TEMPLATES = '/app/templates';
  const BOT_CLAUDE_LOCAL = '/home/node/.claude/CLAUDE.md';
  if (!fs.existsSync(BOT_CLAUDE_LOCAL)) {
    const src = path.join(TEMPLATES, 'BOT_CLAUDE.md');
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, BOT_CLAUDE_LOCAL);
      logger.info('Default BOT_CLAUDE.md copied to ~/.claude/CLAUDE.md (first run)');
    }
  }
  // Ensure reference files available
  copyIfMissing(TEMPLATES, 'CODING_REFERENCE.md', '/workspace/reference');

  // 4. Build append content (managed policy + identity + channel + runtime)
  const appendContent = buildAppendContent({
    botId,
    botName,
    channelType: payload.channelType,
    groupJid,
    model: payload.model,
    isScheduledTask: payload.isScheduledTask,
  });
  logger.info(
    { appendContentLength: appendContent.length },
    'Append content built',
  );

  const agentPrompt = prompt;

  // 6. Build environment for Claude Agent SDK
  //    CLAUDE_CODE_USE_BEDROCK=1 is set in the container env, but ensure it's passed through
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_USE_BEDROCK: '1',
  };

  // 7. Resolve MCP server path (mcp-server.js in same dist directory)
  const mcpServerPath = path.join(__dirname, 'mcp-server.js');

  // 7. Run Claude Agent SDK query
  logger.info('Starting agent query');
  const result = await runAgentQuery({
    prompt: agentPrompt,
    mcpServerPath,
    sdkEnv,
    appendContent,
    botId,
    botName,
    groupJid,
    userId,
    payload,
    logger,
  });

  // 9. Sync session and memory back to S3
  logger.info('Syncing session back to S3');
  await syncToS3(s3, SESSION_BUCKET, syncPaths, logger);

  logger.info(
    { status: result.status, sessionId: result.newSessionId },
    'Invocation complete',
  );

  return result;
}

// ---------------------------------------------------------------------------
// Agent query execution
// ---------------------------------------------------------------------------

interface QueryParams {
  prompt: string;
  mcpServerPath: string;
  sdkEnv: Record<string, string | undefined>;
  appendContent: string;
  botId: string;
  botName: string;
  groupJid: string;
  userId: string;
  payload: InvocationPayload;
  logger: pino.Logger;
}

async function runAgentQuery(params: QueryParams): Promise<InvocationResult> {
  const { prompt, mcpServerPath, sdkEnv, appendContent, payload, logger } = params;

  let newSessionId: string | undefined;
  let lastResult: string | null = null;
  let messageCount = 0;
  let resultCount = 0;
  let tokensUsed = 0;

  // Discover additional directories mounted at /workspace/extra/*
  // (same pattern as NanoClaw for plugin directories)
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    logger.info({ extraDirs }, 'Additional directories discovered');
  }

  try {
    for await (const message of query({
      prompt,
      options: {
        model: payload.model || DEFAULT_MODEL,
        cwd: '/workspace/group',
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        continue: true,
        systemPrompt: {
          type: 'preset' as const,
          preset: 'claude_code' as const,
          append: appendContent,
        },
        // Same tool allowlist as NanoClaw's agent-runner
        allowedTools: [
          'Bash',
          'Read',
          'Write',
          'Edit',
          'Glob',
          'Grep',
          'WebSearch',
          'WebFetch',
          'Task',
          'TaskOutput',
          'TaskStop',
          'TeamCreate',
          'TeamDelete',
          'SendMessage',
          'TodoWrite',
          'ToolSearch',
          'Skill',
          'NotebookEdit',
          'mcp__nanoclawbot__*',
        ],
        env: sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['user', 'project'],
        maxTurns: payload.maxTurns,
        mcpServers: {
          nanoclawbot: {
            command: 'node',
            args: [mcpServerPath],
            env: {
              CLAWBOT_BOT_ID: params.botId,
              CLAWBOT_BOT_NAME: params.botName,
              CLAWBOT_GROUP_JID: params.groupJid,
              CLAWBOT_USER_ID: params.userId,
              CLAWBOT_CHANNEL_TYPE: payload.channelType,
              // Scoped credentials are inherited from process.env
              // (the runtime's IAM role can assume the scoped role)
              SCOPED_ROLE_ARN: process.env.SCOPED_ROLE_ARN || '',
              AWS_REGION: process.env.AWS_REGION || 'us-east-1',
              SQS_REPLIES_URL: process.env.SQS_REPLIES_URL || '',
              TABLE_TASKS: process.env.TABLE_TASKS || '',
              SCHEDULER_ROLE_ARN: process.env.SCHEDULER_ROLE_ARN || '',
              SQS_MESSAGES_ARN: process.env.SQS_MESSAGES_ARN || '',
            },
          },
        },
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook(params.botName)] }],
        },
      },
    })) {
      messageCount++;

      switch (message.type) {
        case 'system': {
          const subtype = (message as { subtype?: string }).subtype;
          if (subtype === 'init') {
            newSessionId = message.session_id;
            logger.info({ sessionId: newSessionId }, 'Session initialized');
          } else {
            logger.info({ subtype }, 'System message');
          }
          break;
        }

        case 'assistant': {
          const msg = (message as { message?: { content?: unknown[]; model?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } } }).message;
          const usage = msg?.usage;
          if (usage) {
            tokensUsed += (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0);
          }
          // Extract tool_use blocks from assistant content
          const content = msg?.content as Array<{ type: string; name?: string; id?: string; text?: string }> | undefined;
          const toolUses = content?.filter((b) => b.type === 'tool_use').map((b) => b.name) || [];
          const textBlocks = content?.filter((b) => b.type === 'text').map((b) => (b.text || '').slice(0, 200)) || [];
          logger.info(
            {
              model: msg?.model,
              inputTokens: usage?.input_tokens,
              outputTokens: usage?.output_tokens,
              cacheCreation: usage?.cache_creation_input_tokens,
              cacheRead: usage?.cache_read_input_tokens,
              toolUses: toolUses.length > 0 ? toolUses : undefined,
              textPreview: textBlocks.length > 0 ? textBlocks[0].slice(0, 150) : undefined,
            },
            'Assistant response',
          );
          break;
        }

        case 'user': {
          const userMsg = message as { parent_tool_use_id?: string | null; isSynthetic?: boolean };
          if (userMsg.parent_tool_use_id) {
            logger.info({ toolUseId: userMsg.parent_tool_use_id }, 'Tool result');
          }
          break;
        }

        case 'tool_use_summary': {
          const summary = (message as { summary?: string }).summary || '';
          logger.info({ summary: summary.slice(0, 300) }, 'Tool use summary');
          break;
        }

        case 'result': {
          resultCount++;
          const rm = message as { subtype?: string; result?: string; duration_ms?: number; num_turns?: number; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number }; stop_reason?: string | null };
          lastResult = rm.result || null;
          logger.info(
            {
              subtype: rm.subtype,
              resultLength: rm.result?.length,
              durationMs: rm.duration_ms,
              numTurns: rm.num_turns,
              costUsd: rm.total_cost_usd,
              inputTokens: rm.usage?.input_tokens,
              outputTokens: rm.usage?.output_tokens,
              stopReason: rm.stop_reason,
              resultPreview: rm.result?.slice(0, 200),
            },
            'Agent result',
          );
          break;
        }

        default:
          logger.debug({ type: message.type, messageCount }, 'SDK message');
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ error: errorMessage, messageCount }, 'Agent query failed');
    return {
      status: 'error',
      result: lastResult,
      newSessionId,
      tokensUsed: tokensUsed || undefined,
      error: errorMessage,
    };
  }

  logger.info(
    { messageCount, resultCount, sessionId: newSessionId },
    'Agent query completed',
  );

  return {
    status: 'success',
    result: lastResult,
    newSessionId,
    tokensUsed: tokensUsed || undefined,
  };
}

// ---------------------------------------------------------------------------
// Session detection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pre-compact hook — archive transcripts before compaction
// (Ported from NanoClaw's agent-runner)
// ---------------------------------------------------------------------------

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);
    } catch {
      // Archiving failure is non-fatal
    }

    return {};
  };
}

// ---------------------------------------------------------------------------
// Transcript parsing helpers (ported from NanoClaw)
// ---------------------------------------------------------------------------

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) return null;

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    return entry?.summary ?? null;
  } catch {
    return null;
  }
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // Skip unparseable lines
    }
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Template copy helper
// ---------------------------------------------------------------------------

function copyIfMissing(templateDir: string, fileName: string, destDir: string): void {
  const src = path.join(templateDir, fileName);
  const dest = path.join(destDir, fileName);
  try {
    if (!fs.existsSync(dest) && fs.existsSync(src)) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, dest);
    }
  } catch {
    // Non-fatal — templates are a nice-to-have
  }
}
