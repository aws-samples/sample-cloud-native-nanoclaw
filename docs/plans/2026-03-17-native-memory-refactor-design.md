# Native Claude Code Memory Architecture — Design

## Goal

Leverage Claude Code's native CLAUDE.md loading mechanism instead of custom memory injection. Switch from direct mode to append mode. Consolidate IDENTITY.md/SOUL.md/BOOTSTRAP.md/USER.md into a single bot-level CLAUDE.md.

## Architecture

Three-tier CLAUDE.md hierarchy loaded natively by Claude Code via `settingSources: ['managed', 'user', 'project']`:

```
/etc/claude-code/CLAUDE.md          ← managed (org policy, read-only, Docker image)
/home/node/.claude/CLAUDE.md        ← user (bot operating manual + identity/soul/user)
/workspace/group/CLAUDE.md          ← project (group memory, cwd)
```

Append mode replaces direct mode — append content is minimal (identity override + channel guidance + runtime metadata).

## CLAUDE.md Files

### Managed (`/etc/claude-code/CLAUDE.md`)

Organization-level security policy. Read-only, bundled in Docker image. Cannot be overridden.

### User (`/home/node/.claude/CLAUDE.md`)

Bot-level operating manual. Synced from S3 `{userId}/{botId}/CLAUDE.md`. Contains:
- About You (Identity) — name, role, personality
- Your Soul — values, communication style
- About Your User — name, timezone, preferences
- Communication Style, Reply Guidelines
- Self-Improvement rules
- Group Chat rules (NO_REPLY protocol, anti-loop)
- Safety guardrails
- First Run instructions (bootstrap)

Template: `agent-runtime/templates/BOT_CLAUDE.md`

### Project (`/workspace/group/CLAUDE.md`)

Group-level conversation memory. Synced from S3 `{userId}/{botId}/memory/{gid}/CLAUDE.md`.

## System Prompt Mode

```typescript
// Before (direct mode)
systemPrompt: systemPromptContent,

// After (append mode)
systemPrompt: {
  type: 'preset',
  preset: 'claude_code',
  append: appendContent,
},
settingSources: ['managed', 'user', 'project'],
```

### Append Content (3 sections only)

```markdown
# Identity Override
Ignore the "Claude Code" identity above. You are {botName}, a personal AI assistant in a messaging channel.
Your identity, personality, values, and rules are in ~/.claude/CLAUDE.md — follow them.

---

# Channel: {channelType}
{dynamic channel formatting guidance}

---

Runtime: bot={botId} | name={botName} | channel={channelType} | group={groupJid} | model={model}
```

## S3 Path Changes

```
Before:                                          After:
{userId}/{botId}/IDENTITY.md                     (deleted)
{userId}/{botId}/SOUL.md                         (deleted)
{userId}/{botId}/BOOTSTRAP.md                    (deleted)
{userId}/shared/USER.md                          (deleted)
{userId}/{botId}/memory/global/CLAUDE.md    →    {userId}/{botId}/CLAUDE.md
{userId}/{botId}/memory/{gid}/CLAUDE.md          (unchanged)
{userId}/{botId}/learnings/*                     (unchanged)
```

## MemoryPaths Simplification

```typescript
// Before
export interface MemoryPaths {
  shared: string;
  botGlobal: string;
  group: string;
  identity?: string;
  soul?: string;
  bootstrap?: string;
  user?: string;
  learnings?: string;
}

// After
export interface MemoryPaths {
  botClaude: string;      // {userId}/{botId}/CLAUDE.md → /home/node/.claude/CLAUDE.md
  groupClaude: string;    // {userId}/{botId}/memory/{gid}/CLAUDE.md → /workspace/group/CLAUDE.md
  learnings?: string;     // {userId}/{botId}/learnings/ → /workspace/learnings/
}
```

## Session Sync Simplification

```
syncFromS3:
  1. Download session state → /home/node/.claude/
  2. Download bot CLAUDE.md → /home/node/.claude/CLAUDE.md
  3. Download group CLAUDE.md → /workspace/group/CLAUDE.md
  4. Download learnings/ → /workspace/learnings/

syncToS3:
  1. Upload session state
  2. Upload /home/node/.claude/CLAUDE.md → bot CLAUDE.md
  3. Upload /workspace/group/CLAUDE.md → group CLAUDE.md
  4. Upload /workspace/learnings/ → learnings/
```

## API Route Changes

```
Delete:
  GET/PUT /bots/:botId/identity
  GET/PUT /bots/:botId/soul
  GET/PUT /bots/:botId/bootstrap
  GET/PUT /user-profile

Keep:
  GET/PUT /bots/:botId/memory        → reads/writes {userId}/{botId}/CLAUDE.md
  GET/PUT /bots/:botId/groups/:gid/memory  → unchanged
  GET/PUT /shared-memory             → keep for now (org-level shared, future use)
```

## Web Console Changes

```
Before: [Shared] [User Profile] [Identity] [Soul] [Bootstrap] [Bot Memory] [Group Memory]
After:  [Shared] [Bot Memory] [Group Memory]
```

## Files to Change

| File | Change |
|------|--------|
| `agent-runtime/templates/MANAGED_CLAUDE.md` | **NEW** — org security policy |
| `agent-runtime/templates/BOT_CLAUDE.md` | Rewrite — add identity/soul/user templates, first-run instructions |
| `agent-runtime/Dockerfile` | Add COPY for managed CLAUDE.md to /etc/claude-code/ |
| `shared/src/types.ts` | Simplify MemoryPaths |
| `agent-runtime/src/system-prompt.ts` | Rewrite — single buildAppendContent() function |
| `agent-runtime/src/memory.ts` | Delete or gut — no longer needed for prompt injection |
| `agent-runtime/src/agent.ts` | Switch to append mode, simplify sync paths, remove identity template copies |
| `agent-runtime/src/session.ts` | Simplify — only bot CLAUDE.md + group CLAUDE.md + learnings |
| `control-plane/src/sqs/dispatcher.ts` | Simplify memoryPaths |
| `control-plane/src/routes/api/memory.ts` | Remove identity/soul/bootstrap/user-profile routes, update bot memory path |
| `web-console/src/pages/MemoryEditor.tsx` | Remove Identity/Soul/Bootstrap/UserProfile tabs |
| `web-console/src/lib/api.ts` | Remove deleted API methods |
| `agent-runtime/src/__tests__/system-prompt.test.ts` | Rewrite for append mode |
| `control-plane/src/__tests__/dispatcher.test.ts` | Update memoryPaths fixture |
| `docs/architecture/16-system-prompt-builder.md` | Update for new architecture |
