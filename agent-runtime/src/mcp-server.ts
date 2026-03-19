/**
 * ClawBot Cloud — Stdio MCP Server
 *
 * Cloud equivalent of NanoClaw's ipc-mcp-stdio.ts.
 * Launched as a child process by Claude Agent SDK.  Exposes tools
 * (send_message, schedule_task, list_tasks, etc.) over MCP stdio transport.
 *
 * Instead of writing IPC files, tools call AWS services directly via
 * scoped credentials passed through environment variables.
 *
 * Environment variables (set by agent.ts when spawning this process):
 *   CLAWBOT_BOT_ID, CLAWBOT_BOT_NAME, CLAWBOT_GROUP_JID,
 *   CLAWBOT_USER_ID, CLAWBOT_CHANNEL_TYPE,
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN  (scoped)
 *
 * Feishu tool env vars (optional, set when channel is 'feishu'):
 *   FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_DOMAIN,
 *   FEISHU_TOOLS_DOC, FEISHU_TOOLS_WIKI, FEISHU_TOOLS_DRIVE, FEISHU_TOOLS_PERM
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import {
  sendMessage,
  sendFile,
  scheduleTask,
  listTasks,
  pauseTask,
  resumeTask,
  cancelTask,
  updateTask,
  validateInterval,
  validateOnce,
  type McpToolContext,
} from './mcp-tools.js';
import { getScopedClients } from './scoped-credentials.js';
import { registerFeishuTools } from './feishu-tools/index.js';
import type { ChannelType } from '@clawbot/shared';

// Build tool context from environment (cached — userId/botId don't change within an invocation)
let cachedContext: McpToolContext | null = null;

async function buildContext(): Promise<McpToolContext> {
  if (cachedContext) return cachedContext;

  const botId = process.env.CLAWBOT_BOT_ID!;
  const userId = process.env.CLAWBOT_USER_ID!;
  const clients = await getScopedClients(userId, botId);

  const ctx: McpToolContext = {
    botId,
    botName: process.env.CLAWBOT_BOT_NAME || 'ClawBot',
    groupJid: process.env.CLAWBOT_GROUP_JID!,
    userId,
    channelType: (process.env.CLAWBOT_CHANNEL_TYPE || 'telegram') as ChannelType,
    clients,
  };
  cachedContext = ctx;
  return ctx;
}

const server = new McpServer({
  name: 'nanoclawbot',
  version: '1.0.0',
});

// --- send_message ---
server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const ctx = await buildContext();
    await sendMessage(ctx, args.text, args.sender);
    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

// --- send_file ---
server.tool(
  'send_file',
  'Send a file from the workspace to the user or group chat. The file must exist under /workspace/group/. Supports documents (PDF, PPTX, DOCX), images (PNG, JPG), and other file types up to 25MB.',
  {
    filePath: z.string().describe('Absolute path to the file, must be under /workspace/group/'),
    caption: z.string().optional().describe('Optional message to accompany the file'),
  },
  async (args) => {
    const ctx = await buildContext();
    await sendFile(ctx, args.filePath, args.caption);
    return {
      content: [{ type: 'text' as const, text: `File sent: ${path.basename(args.filePath)}` }],
    };
  },
);

// --- schedule_task ---
server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference.

CONTEXT MODE:
\u2022 "group": Task runs in the group's conversation context, with access to chat history.
\u2022 "isolated": Task runs in a fresh session with no conversation history.

SCHEDULE VALUE FORMAT:
\u2022 cron: AWS EventBridge 6-field format: "minute hour day-of-month month day-of-week year"
  IMPORTANT RULES:
  - day-of-month and day-of-week CANNOT both be * — use ? for the one you don't care about
  - Use ? as a wildcard for "any" in day-of-month OR day-of-week (not both)
  - Year is usually * (every year)
  Examples:
    "20 23 * * ? *"   = daily at 23:20 UTC
    "0 8 * * ? *"     = daily at 8:00 UTC
    "0 9 ? * 2-6 *"   = weekdays (Mon-Fri) at 9:00 UTC (1=SUN, 2=MON ... 7=SAT)
    "*/30 * * * ? *"  = every 30 minutes
    "0 0 1 * ? *"     = first day of month at midnight
\u2022 interval: Milliseconds between runs (min 60000). Examples: "300000" (5 min), "3600000" (1 hour)
\u2022 once: Local time WITHOUT "Z" suffix. Example: "2026-02-01T15:30:00"

If the schedule expression is invalid, AWS will return an error — read it and correct the format.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: AWS 6-field e.g. "0 8 * * ? *" (use ? for day-of-week or day-of-month) | interval: milliseconds e.g. "300000" | once: local time e.g. "2026-02-01T15:30:00" (no Z!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe('group=runs with chat history, isolated=fresh session'),
  },
  async (args) => {
    // Validate interval and once locally (simple checks); cron is validated by AWS EventBridge
    if (args.schedule_type === 'interval') {
      const err = validateInterval(args.schedule_value);
      if (err) return { content: [{ type: 'text' as const, text: err }], isError: true };
    } else if (args.schedule_type === 'once') {
      const err = validateOnce(args.schedule_value);
      if (err) return { content: [{ type: 'text' as const, text: err }], isError: true };
    }

    try {
      const ctx = await buildContext();
      const taskId = await scheduleTask(
        ctx,
        args.prompt,
        args.schedule_type,
        args.schedule_value,
        args.context_mode,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Failed to create schedule: ${message}` }], isError: true };
    }
  },
);

// --- list_tasks ---
server.tool(
  'list_tasks',
  "List all scheduled tasks for this bot.",
  {},
  async () => {
    const ctx = await buildContext();
    const tasks = await listTasks(ctx);

    if (tasks.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
    }

    const formatted = tasks
      .map(
        (t) =>
          `- [${t.taskId}] ${t.prompt.slice(0, 50)}... (${t.scheduleType}: ${t.scheduleValue}) - ${t.status}, next: ${t.nextRun || 'N/A'}`,
      )
      .join('\n');

    return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
  },
);

// --- pause_task ---
server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const ctx = await buildContext();
    await pauseTask(ctx, args.task_id);
    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} paused.` }] };
  },
);

// --- resume_task ---
server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const ctx = await buildContext();
    await resumeTask(ctx, args.task_id);
    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resumed.` }] };
  },
);

// --- cancel_task ---
server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const ctx = await buildContext();
    await cancelTask(ctx, args.task_id);
    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancelled.` }] };
  },
);

// --- update_task ---
server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed. Cron format: AWS 6-field "minute hour dom month dow year" (use ? for day-of-week or day-of-month). See schedule_task for full format docs.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate interval and once locally; cron validated by AWS
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const err = validateInterval(args.schedule_value);
      if (err) return { content: [{ type: 'text' as const, text: err }], isError: true };
    }
    if (args.schedule_type === 'once' && args.schedule_value) {
      const err = validateOnce(args.schedule_value);
      if (err) return { content: [{ type: 'text' as const, text: err }], isError: true };
    }

    try {
      const ctx = await buildContext();
      await updateTask(ctx, args.task_id, {
        prompt: args.prompt,
        scheduleType: args.schedule_type,
        scheduleValue: args.schedule_value,
      });
      return {
        content: [{ type: 'text' as const, text: `Task ${args.task_id} updated.` }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Failed to update schedule: ${message}` }], isError: true };
    }
  },
);

// --- Feishu/Lark tools (conditional — only when credentials are provided) ---
const feishuAppId = process.env.FEISHU_APP_ID;
const feishuAppSecret = process.env.FEISHU_APP_SECRET;

if (feishuAppId && feishuAppSecret) {
  await registerFeishuTools(
    server,
    {
      appId: feishuAppId,
      appSecret: feishuAppSecret,
      domain: process.env.FEISHU_DOMAIN,
    },
    {
      doc: process.env.FEISHU_TOOLS_DOC === '1',
      wiki: process.env.FEISHU_TOOLS_WIKI === '1',
      drive: process.env.FEISHU_TOOLS_DRIVE === '1',
      perm: process.env.FEISHU_TOOLS_PERM === '1',
    },
  );
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
