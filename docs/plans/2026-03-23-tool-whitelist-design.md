# Tool & Skill Whitelist Design

**Date:** 2026-03-23
**Status:** Implemented

## Overview

Per-bot tool and skill whitelist mechanism for NanoClaw on Cloud. Default is OFF (all tools/skills allowed). Bot owners can enable the whitelist and explicitly select which MCP tools and skills the agent is permitted to use. Enforcement happens at agent runtime via a PreToolUse hook.

Reference implementation: [owork `create_skill_access_checker`](https://github.com/xiehust/owork/blob/main/backend/core/agent_manager.py)

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scope | Per-bot | Bots serve different purposes/channels, need different tools |
| What's controlled | MCP tools + Skills | Meaningful security control. Built-in tools (Bash, Read, Write) left unrestricted — they're core to agent function |
| UI for tool selection | Predefined checkboxes + free-text for custom skills | MCP tools and pre-installed skills are enumerable; custom skills need flexibility |
| Enforcement | PreToolUse hook in agent-runtime | Matches owork pattern, intercepts at runtime before tool execution |

## Data Model

### Type Changes (`shared/src/types.ts`)

```typescript
export interface ToolWhitelistConfig {
  enabled: boolean;              // default false — when off, all tools/skills allowed
  allowedMcpTools: string[];     // e.g. ["send_message", "schedule_task"]
  allowedSkills: string[];       // e.g. ["pdf", "docx", "agent-browser"]
}

export interface Bot {
  // ... existing fields ...
  toolWhitelist?: ToolWhitelistConfig;  // new field
}
```

When `enabled: false` or `toolWhitelist` is undefined, agent has full access (backward-compatible). When `enabled: true`, only tools/skills in the lists are permitted.

The config flows through the existing path: **DynamoDB Bot record → Dispatcher → InvocationPayload → agent-runtime PreToolUse hook**.

## Agent Runtime — PreToolUse Hook (`agent-runtime/src/agent.ts`)

```typescript
PreToolUse: [
  {
    handler: async (input) => {
      const { toolWhitelist } = payload;
      if (!toolWhitelist?.enabled) return undefined; // whitelist off, allow all

      const toolName = input.tool_name;
      const toolInput = input.tool_input;

      // Check Skill tool — inspect the skill name inside tool_input
      if (toolName === 'Skill') {
        const requestedSkill = toolInput?.skill || '';
        if (!toolWhitelist.allowedSkills.includes(requestedSkill)) {
          logger.warn({
            event: 'tool_access_denied',
            botId: payload.botId,
            userId: payload.userId,
            sessionId: payload.sessionId,
            toolType: 'skill',
            requestedTool: requestedSkill,
            allowedTools: toolWhitelist.allowedSkills,
          }, `Skill access denied: ${requestedSkill}`);
          return {
            permissionDecision: 'deny',
            permissionDecisionReason: `Skill "${requestedSkill}" is not allowed for this bot.`
          };
        }
      }

      // Check MCP tools — format is "mcp__nanoclawbot__<toolName>"
      if (toolName.startsWith('mcp__nanoclawbot__')) {
        const mcpToolName = toolName.replace('mcp__nanoclawbot__', '');
        if (!toolWhitelist.allowedMcpTools.includes(mcpToolName)) {
          logger.warn({
            event: 'tool_access_denied',
            botId: payload.botId,
            userId: payload.userId,
            sessionId: payload.sessionId,
            toolType: 'mcp_tool',
            requestedTool: mcpToolName,
            allowedTools: toolWhitelist.allowedMcpTools,
          }, `MCP tool access denied: ${mcpToolName}`);
          return {
            permissionDecision: 'deny',
            permissionDecisionReason: `Tool "${mcpToolName}" is not allowed for this bot.`
          };
        }
      }

      return undefined; // allow
    }
  }
]
```

## Control-Plane API Changes (`control-plane/src/routes/api/bots.ts`)

### Update bot — `PUT /api/bots/:botId`

Add `toolWhitelist` to the update schema:

```typescript
toolWhitelist: z.object({
  enabled: z.boolean(),
  allowedMcpTools: z.array(z.string()),
  allowedSkills: z.array(z.string()),
}).optional()
```

### New endpoint — `GET /api/bots/available-tools`

Returns the catalog of known MCP tools and pre-installed skills:

```json
{
  "mcpTools": [
    { "name": "send_message", "description": "Send a message to the channel" },
    { "name": "send_file", "description": "Send a file to the channel" },
    { "name": "schedule_task", "description": "Schedule a recurring task" },
    { "name": "list_tasks", "description": "List scheduled tasks" },
    { "name": "pause_task", "description": "Pause a task" },
    { "name": "resume_task", "description": "Resume a paused task" },
    { "name": "cancel_task", "description": "Cancel a task" },
    { "name": "update_task", "description": "Update a task" }
  ],
  "skills": [
    { "name": "agent-browser", "description": "Browser automation" },
    { "name": "docx", "description": "Word document creation" },
    { "name": "find-skills", "description": "Discover available skills" },
    { "name": "pdf", "description": "PDF manipulation" },
    { "name": "pptx", "description": "PowerPoint creation" },
    { "name": "skill-creator", "description": "Create new skills" },
    { "name": "skill-development", "description": "Skill development tools" },
    { "name": "xlsx", "description": "Excel spreadsheet creation" }
  ]
}
```

### Dispatcher change (`control-plane/src/sqs/dispatcher.ts`)

Pass `toolWhitelist` from the bot record into `InvocationPayload` alongside existing fields (`systemPrompt`, `model`, etc.).

## Web Console UI (`web-console/src/pages/BotDetail.tsx`)

Add a **"Tools"** tab to BotDetail, after the "Memory" tab.

```
┌─────────────────────────────────────────────────┐
│  Tool Whitelist                                  │
│  ┌───────────────────────────────────────────┐  │
│  │ ○ Off (all tools & skills allowed)        │  │
│  │ ● On  (only selected items allowed)       │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  ── MCP Tools ──────────────────────────────────│
│  ☑ send_message    ☑ send_file                  │
│  ☑ schedule_task   ☑ list_tasks                 │
│  ☐ pause_task      ☐ resume_task                │
│  ☐ cancel_task     ☐ update_task                │
│                                                  │
│  ── Skills ─────────────────────────────────────│
│  ☑ pdf             ☑ docx                       │
│  ☑ pptx            ☑ xlsx                       │
│  ☐ agent-browser   ☐ find-skills                │
│  ☐ skill-creator   ☐ skill-development          │
│                                                  │
│  ── Custom Skills ──────────────────────────────│
│  [ Enter skill name...        ] [+ Add]         │
│  ┌──────────┐ ┌──────────┐                      │
│  │ my-skill ✕│ │ custom-x ✕│                     │
│  └──────────┘ └──────────┘                      │
│                                                  │
│              [ Save Changes ]                    │
└─────────────────────────────────────────────────┘
```

- **Toggle off** → greyed-out checkboxes, all tools allowed
- **Toggle on** → checkboxes interactive, nothing checked by default
- **MCP tools & pre-installed skills** from `GET /api/bots/available-tools` rendered as checkboxes
- **Custom skills** added as free-text tags with remove (✕) button
- **Save** calls `PUT /api/bots/:botId` with `toolWhitelist` payload

## Audit Logging

Denied tool uses are logged as structured Pino entries in agent-runtime:

```typescript
logger.warn({
  event: 'tool_access_denied',
  botId, userId, groupJid,
  toolType: 'skill' | 'mcp_tool',
  requestedTool: '<tool-name>',
  allowedTools: [...],
}, `Tool access denied: <tool-name>`);
```

Flows through existing Pino → CloudWatch Logs pipeline. Searchable via CloudWatch Logs Insights with `event: "tool_access_denied"`.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| `toolWhitelist` undefined on bot | Treated as disabled, all tools allowed (backward-compatible) |
| Whitelist enabled, empty lists | All MCP tools and skills blocked. Built-in tools still work. |
| Feishu tools (doc, wiki, drive, perm) | Covered as MCP tools under `mcp__nanoclawbot__` namespace |
| Mid-session config change | Takes effect on next invocation (next message) |
| Denied tool | Agent receives denial reason, can inform user |

## Not Included (YAGNI)

- Role-based tool access (all bot owners manage their own bots)
- Tool usage analytics
- "Blocklist" mode (inverse of whitelist)

## Files to Modify

| File | Change |
|------|--------|
| `shared/src/types.ts` | Add `ToolWhitelistConfig`, extend `Bot` and `InvocationPayload` |
| `agent-runtime/src/agent.ts` | Add PreToolUse hook with whitelist enforcement |
| `control-plane/src/routes/api/bots.ts` | Extend update schema, add `GET /available-tools` |
| `control-plane/src/sqs/dispatcher.ts` | Pass `toolWhitelist` to InvocationPayload |
| `web-console/src/pages/BotDetail.tsx` | Add "Tools" tab with whitelist UI |
