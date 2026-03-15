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
 *   - Multi-layer CLAUDE.md memory (shared → bot global → group)
 *   - Pre-compact hook for conversation archiving
 *   - Session resumption via sessionId
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { S3Client } from '@aws-sdk/client-s3';
import type pino from 'pino';
import type { InvocationPayload, InvocationResult } from '@clawbot/shared';
import { syncFromS3, syncToS3, type SyncPaths } from './session.js';
import { loadMemoryLayers } from './memory.js';
import { getScopedClients } from './scoped-credentials.js';

const SESSION_BUCKET = process.env.SESSION_BUCKET || '';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Main invocation handler
// ---------------------------------------------------------------------------

export async function handleInvocation(
  payload: InvocationPayload,
  logger: pino.Logger,
): Promise<InvocationResult> {
  const { botId, botName, groupJid, userId, prompt, sessionPath, memoryPaths } = payload;

  // 1. Get scoped credentials (STS ABAC — userId + botId tags)
  logger.info({ botId, userId }, 'Acquiring scoped credentials');
  const scopedClients = await getScopedClients(userId, botId);

  // Also create an S3 client with the scoped credentials for session sync
  const s3 = scopedClients.s3;

  // 2. Sync session and memory from S3 → local workspace
  const syncPaths: SyncPaths = {
    sessionPath,
    groupMemory: memoryPaths.group,
    botGlobalMemory: memoryPaths.botGlobal,
    sharedMemory: memoryPaths.shared,
  };

  logger.info({ sessionPath, groupJid }, 'Syncing session from S3');
  await syncFromS3(s3, SESSION_BUCKET, syncPaths, logger);

  // 3. Load memory layers into system prompt
  const memoryContent = await loadMemoryLayers();
  logger.info(
    { memoryLength: memoryContent.length },
    'Memory layers loaded',
  );

  // 4. Build prompt (prepend scheduled-task marker like NanoClaw does)
  let agentPrompt = prompt;
  if (payload.isScheduledTask) {
    agentPrompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  // 5. Build environment for Claude Agent SDK
  //    CLAUDE_CODE_USE_BEDROCK=1 is set in the container env, but ensure it's passed through
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_USE_BEDROCK: '1',
  };

  // 6. Resolve MCP server path (mcp-server.js in same dist directory)
  const mcpServerPath = path.join(__dirname, 'mcp-server.js');

  // 7. Determine session ID for resumption
  //    If the payload doesn't specify one, Claude SDK will create a new session
  const existingSessionId = detectExistingSession();

  // 8. Run Claude Agent SDK query
  logger.info({ sessionId: existingSessionId || 'new' }, 'Starting agent query');
  const result = await runAgentQuery({
    prompt: agentPrompt,
    sessionId: existingSessionId,
    mcpServerPath,
    sdkEnv,
    memoryContent,
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
  sessionId: string | undefined;
  mcpServerPath: string;
  sdkEnv: Record<string, string | undefined>;
  memoryContent: string;
  botId: string;
  botName: string;
  groupJid: string;
  userId: string;
  payload: InvocationPayload;
  logger: pino.Logger;
}

async function runAgentQuery(params: QueryParams): Promise<InvocationResult> {
  const { prompt, sessionId, mcpServerPath, sdkEnv, memoryContent, payload, logger } = params;

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
        cwd: '/workspace/group',
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: sessionId,
        systemPrompt: memoryContent
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: memoryContent }
          : undefined,
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
          'mcp__clawbot__*',
        ],
        env: sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        maxTurns: payload.maxTurns,
        mcpServers: {
          clawbot: {
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
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      logger.debug({ messageCount, msgType }, 'SDK message');

      // Track session initialization
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        logger.info({ sessionId: newSessionId }, 'Session initialized');
      }

      // Track token usage from result messages
      if (message.type === 'result') {
        resultCount++;
        const textResult = 'result' in message ? (message as { result?: string }).result : null;
        if (textResult) {
          lastResult = textResult;
        }
        logger.info(
          { resultCount, resultLength: textResult?.length },
          'Agent result received',
        );
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

/**
 * Detect if a previous session exists in the Claude state directory.
 * Session files are synced from S3 before this is called.
 */
function detectExistingSession(): string | undefined {
  const claudeDir = '/home/node/.claude';
  const projectsDir = path.join(claudeDir, 'projects');

  try {
    if (!fs.existsSync(projectsDir)) return undefined;

    // Look for session directories inside projects/
    // Claude Code stores sessions under projects/{project-hash}/sessions/
    const projectDirs = fs.readdirSync(projectsDir);
    for (const projDir of projectDirs) {
      const sessionsDir = path.join(projectsDir, projDir, 'sessions');
      if (!fs.existsSync(sessionsDir)) continue;

      const sessions = fs.readdirSync(sessionsDir).sort();
      if (sessions.length > 0) {
        // Return the most recent session ID
        return sessions[sessions.length - 1];
      }
    }
  } catch {
    // No existing session found
  }

  return undefined;
}

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
