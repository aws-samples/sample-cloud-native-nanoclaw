# Skills Management Feature Design

**Date:** 2026-03-27
**Status:** Approved

## Overview

Add a global Skills management feature to the NanoClaw on Cloud platform. Platform admins publish Claude Code skills (`.md` files with YAML frontmatter) to a shared library. Bot owners select which skills to enable per bot. Enabled skills are downloaded to `~/.claude/skills/` in the agent runtime at invocation time.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Skill type | Claude Code skills (`.md` files) | Simplest unit; Claude SDK natively discovers `~/.claude/skills/` |
| Scope | Global (platform-level) | Single shared library managed by platform admin |
| Enable mechanism | Admin publishes, bot owner selects | Two-tier: admin curates library, bot owner picks per-bot |
| Git install | Server clones at upload time | No git dependency in agent-runtime; simpler, faster startup |

## Data Model

### New: Skills DynamoDB Table

```
Skills Table (PK: skillId)
├── skillId        ULID
├── name           string, display name
├── description    string
├── version        string (e.g. "1.0.0")
├── source         "zip" | "git"
├── sourceUrl      string | null (git repo URL; null for zip)
├── fileCount      number
├── files          string[] (relative paths of .md files)
├── status         "active" | "disabled"
├── createdAt      ISO timestamp
├── updatedAt      ISO timestamp
├── createdBy      admin userId
```

### Modified: Bots Table

Add attribute:
```
skills            string[] (list of enabled skillIds)
```

### S3 Storage

Global prefix (no userId scoping):
```
s3://{bucket}/skills/{skillId}/
  ├── metadata.json
  ├── skill-file-1.md
  ├── skill-file-2.md
  └── ...
```

## Control Plane API

### Admin Routes (require `isAdmin`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/admin/skills` | List all skills (optional `?status=active\|disabled`) |
| `POST` | `/api/admin/skills/upload` | Upload skill from zip (multipart form) |
| `POST` | `/api/admin/skills/git` | Install skill from git repo URL |
| `GET` | `/api/admin/skills/:skillId` | Get skill detail + file list |
| `PUT` | `/api/admin/skills/:skillId` | Update metadata (name, description, status) |
| `DELETE` | `/api/admin/skills/:skillId` | Delete skill (S3 + DDB cleanup) |

### Bot Owner Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/bots/:botId/skills` | List available skills + enabled state for this bot |
| `PUT` | `/api/bots/:botId/skills` | Update enabled skills `{ skills: ["id1", "id2"] }` |

### Upload Flow (zip)

1. Admin uploads zip via multipart form data
2. Server extracts archive to temp directory
3. Validates: must contain at least one `.md` file with valid YAML frontmatter
4. Generates `skillId` (ULID)
5. Uploads `.md` files to `s3://bucket/skills/{skillId}/`
6. Writes `metadata.json` to S3
7. Creates record in DDB Skills table
8. Returns skill metadata

### Git Install Flow

1. Admin provides `{ url: "https://github.com/...", path?: "skills/subfolder" }`
2. Server clones repo to temp directory (shallow clone, depth=1)
3. If `path` specified, scopes to that subdirectory
4. Extracts `.md` files, validates frontmatter
5. Same storage flow as zip (S3 + DDB)
6. Stores `sourceUrl` in DDB for reference

## Web Console UI

### Admin: Skills Tab in AdminPage

Add a **Skills** tab to the existing `AdminPage` `TabNav` (alongside Users, Plans):

- **Skills list table** columns: name, version, file count, source (zip/git icon), status badge, created date, actions
- **"Add Skill" button** opens modal with two sub-tabs:
  - **Upload tab**: drag-and-drop zone for `.zip` file, name input, description textarea
  - **Git tab**: URL input, optional subdirectory path, name input, description textarea
- **Row actions**: Edit (name/description inline), Enable/Disable toggle, Delete (confirmation dialog)
- Follows existing patterns: `Badge` for status, confirmation dialogs for destructive actions, `useEffect` data loading

### Bot Owner: Skills Tab in BotDetail

Add a **Skills** tab to the existing `BotDetail` page tabs (alongside Overview, Channels, etc.):

- Lists all `status: "active"` skills from the global library
- Each row: skill name, description, version, toggle switch (enabled/disabled for this bot)
- **Save** button persists selection via `PUT /api/bots/:botId/skills`
- Read-only view of skill details (no upload/edit capability)

## Agent Runtime Integration

### Payload Change

Add `skills?: string[]` to `InvocationPayload` in `@clawbot/shared`. This carries the list of enabled skillIds from the SQS message to the agent-runtime.

### Download Flow (in `handleInvocation()`)

After S3 session sync, before agent query:

```
for each skillId in payload.skills:
  download s3://bucket/skills/{skillId}/*.md
    → /home/node/.claude/skills/{skillId}/
```

- Uses the global S3 client (not scoped credentials — skills are platform-level, not user-scoped)
- Claude Code SDK discovers `~/.claude/skills/` automatically via `settingSources: ['user']`
- Skills are small `.md` files — download latency is negligible
- No caching needed — AgentCore microVMs are ephemeral

### Data Flow

```
DDB Bots table (skills[])
  → SQS FIFO message (InvocationPayload.skills)
    → agent-runtime handleInvocation()
      → S3 download to ~/.claude/skills/{skillId}/
        → Claude Code SDK auto-discovers skills
```

## Implementation Scope

### Packages to modify

1. **shared** — Add `Skill` type, update `InvocationPayload`, add Skills table constants
2. **control-plane** — New admin skills routes, skill upload/git service, bot skills routes, DDB operations
3. **agent-runtime** — Download skills from S3 in `handleInvocation()`
4. **web-console** — Admin Skills tab, BotDetail Skills tab, API client methods, i18n strings
5. **infra** — Add Skills DynamoDB table to Foundation stack

### Not in scope

- Skill versioning/rollback (can be added later)
- Skill marketplace or community sharing
- Per-tenant skill libraries
- Runtime skill updates (skills only load at invocation start)
- Skill dependency management
