# Unified S3 Incremental Sync (AgentCore + ECS)

**Status:** Implemented
**Date:** 2026-04-14
**Supersedes:** `2026-04-12-ecs-s3-incremental-sync.md` (ECS-only design)

## Problem

Both deployment modes (AgentCore microVMs and ECS dedicated tasks) reuse the same VM/task for consecutive same-session invocations — AgentCore via sticky session routing within the idle window, ECS via dedicated per-botId#groupJid tasks. Currently every `/invocations` request unconditionally runs `cleanLocalWorkspace()` → `syncFromS3()` (full download) → agent → `syncToS3()` (full upload), wasting time re-transferring unchanged files that are already present on local disk.

Additionally, the current sync has a correctness bug: **file deletions are never synchronized**. If an agent deletes a local file, the stale S3 object persists and reappears on next download. If a file is deleted from S3 (e.g., via web console), the local copy persists in incremental mode.

## Design Principles

1. **Branch on session continuity, not deployment mode.** Both AgentCore warm sessions and ECS dedicated tasks benefit equally from incremental sync.
2. **Upload optimization applies to all paths.** Even on a full-sync first request, the agent only modifies a subset of files — skip uploading the rest.
3. **Delete synchronization in both directions.** Agent-side deletions propagate to S3; S3-side deletions propagate to local.

## SyncState Tracker

An in-process singleton in `session.ts`. Pure in-memory — VM/task restart naturally falls back to full sync.

```typescript
class SyncState {
  /** Whether first full sync has completed on this VM/task */
  initialized: boolean = false;

  /** S3 key → ETag from last download/upload (for incremental download comparison) */
  s3Etags: Map<string, string> = new Map();

  /** Per-prefix set of S3 keys downloaded in current invocation (for upload-side delete sync) */
  downloadedKeys: Map<string, Set<string>> = new Map();

  /** Local file stat snapshot taken after download, before agent runs (for upload optimization) */
  localSnapshot: Map<string, { mtimeMs: number; size: number }> = new Map();

  /** Record ETag for a downloaded/uploaded S3 key */
  recordEtag(key: string, etag: string): void;

  /** Record that a key was downloaded under a given prefix */
  recordDownloadedKey(prefix: string, key: string): void;

  /** Snapshot all files in given directories via stat() */
  takeLocalSnapshot(dirs: string[]): Promise<void>;

  /** Clear ETags for a specific S3 prefix (used by forceNewSession) */
  clearPrefix(prefix: string): void;

  /** Full reset (session switch or first run) */
  reset(): void;
}
```

## Three Sync Paths

### Path selection logic (in `agent.ts`)

```typescript
const sessionKey = `${botId}#${groupJid}`;
const isSessionContinuation = syncState.initialized
  && currentSessionKey === sessionKey
  && !forceNewSession;

if (forceNewSession) {
  // Path C: model/provider changed → full clean + session reset
} else if (isSessionContinuation) {
  // Path B: same session, subsequent request → incremental
} else {
  // Path A: first request or session switch → full clean + full sync
}
```

### Path A — Full sync (first request / session switch)

Identical to current behavior, plus state recording.

1. `cleanLocalWorkspace()` — wipe all local dirs, restore bundled skills
2. Download platform skills (if any)
3. `syncFromS3()` — full download of session + botClaude + groupPrefix + learnings
4. Record all downloaded S3 keys and ETags into `syncState`
5. `syncState.takeLocalSnapshot()` over all sync directories
6. `syncState.initialized = true`

**When this path triggers:**
- AgentCore: new microVM (process just started, `initialized = false`)
- AgentCore: VM recycled to different session (`currentSessionKey` mismatch)
- ECS: new task (process just started, `initialized = false`)
- ECS: task reassigned to different session (shouldn't happen, but handled safely)

### Path B — Incremental sync (same session, subsequent request)

The core optimization path.

**Download phase:**

1. **Skip** `cleanLocalWorkspace()` — same session, no cross-tenant risk
2. **Skip** session state download — only this VM/task writes to it, local is authoritative
3. **Incremental download** for memory files (botClaude, groupPrefix, learnings):
   - `ListObjectsV2` to get current S3 listing with ETags
   - Compare each object's ETag with `syncState.s3Etags`
   - **ETag changed** → re-download the file, update `s3Etags`
   - **New key** (not in `s3Etags`) → download, record ETag
   - **Key in `s3Etags` but missing from S3 listing** → delete local file (S3-side deletion, e.g., web console)
4. **Skills** — always re-download (may be updated via web console between invocations)
5. Record `downloadedKeys` for upload-side delete sync
6. `syncState.takeLocalSnapshot()` over all sync directories

**Why skipping session download is safe:**
- AgentCore: sticky routing guarantees same VM within idle window; only this VM writes session state
- ECS: dedicated task per session; only this task writes session state
- If VM/task restarts, `syncState.initialized` is false → Path A (full download)

### Path C — Force new session (model/provider change)

1. `cleanLocalWorkspace()`
2. `clearSessionDirectory()` — delete all S3 objects under session prefix
3. `syncMemoryOnlyFromS3()` — download only botClaude + groupPrefix + learnings
4. `syncState.clearPrefix(sessionPrefix)` — invalidate stale session ETags
5. Record new ETags and `downloadedKeys`
6. `syncState.takeLocalSnapshot()`
7. `syncState.initialized` stays `true` (no need to re-do full sync next time)

## Upload Phase (Unified — All Paths)

Same logic regardless of which download path was taken.

### Step 1: Diff local files against snapshot

For each sync directory (session, groupPrefix, learnings):

```
walk local files:
  if file not in localSnapshot → new file → upload
  if file in localSnapshot but mtime or size changed → modified → upload
  if file in localSnapshot and unchanged → skip upload
```

### ~~Step 2: Delete sync (agent-side deletions → S3)~~ — REMOVED

Local file deletions do **not** propagate to S3. S3 is the source of truth.
If the agent deletes a file locally, it will be restored on the next full sync (Path A).
Only S3-side deletions propagate to local (handled by `downloadDirectoryIncremental` and `downloadFileIfChanged`).

### Step 3: Upload botClaude

`botClaude` is a single file — check snapshot, upload only if changed.

### Step 4: Update SyncState

Record new ETags from PutObject responses into `syncState.s3Etags`.

## New Functions in session.ts

| Function | Purpose |
|----------|---------|
| `incrementalSyncFromS3()` | Path B download orchestrator — skip session, ETag-check memory |
| `downloadDirectoryIncremental()` | ListObjectsV2 + ETag comparison, download changed/new, delete removed |
| `downloadFileIfChanged()` | HeadObject ETag check for single file (botClaude) |
| `incrementalUpload()` | Snapshot-based upload with delete sync (replaces raw `uploadDirectory`) |
| `SyncState` class | In-memory state tracker with snapshot, ETag, and downloadedKeys management |

Existing functions (`syncFromS3`, `syncToS3`, `downloadDirectory`, `uploadDirectory`) remain for Path A full sync, but are augmented to record state into `SyncState`.

## Expected Impact

### Performance

| Operation | Before | After (Path B) |
|-----------|--------|-----------------|
| Session state download | Full download (largest transfer) | Skipped entirely |
| botClaude check | Full GetObject | Single HeadObject (~3ms) |
| Group workspace download | Full download | Only changed files |
| Session state upload | Full upload | Only changed files (typically just JSONL append) |
| Group workspace upload | Full upload | Only changed files |

### Correctness

| Bug | Before | After |
|-----|--------|-------|
| Agent deletes file, reappears next sync | Not fixed | Fixed (upload-side delete sync) |
| S3 file deleted, local copy persists | Not fixed (masked by cleanLocalWorkspace) | Fixed (download-side delete sync in Path B) |

### Applicability

| Mode | Download optimization | Upload optimization | Delete sync |
|------|:--------------------:|:-------------------:|:-----------:|
| AgentCore (warm) | Yes (Path B) | Yes (all paths) | Yes (all paths) |
| AgentCore (cold) | No (Path A) | Yes (all paths) | Yes (all paths) |
| ECS (subsequent) | Yes (Path B) | Yes (all paths) | Yes (all paths) |
| ECS (first) | No (Path A) | Yes (all paths) | Yes (all paths) |

## Edge Cases

### AgentCore VM recycled after idle timeout
- New VM starts → `syncState.initialized = false` → Path A. No risk.

### ECS task killed (OOM, spot reclaim, idle timeout)
- New task starts → `syncState.initialized = false` → Path A. Last upload ensures S3 is up to date.

### Web console edits memory while session is active
- Path B `ListObjectsV2` detects ETag change → re-downloads. Correct.

### Web console deletes memory file while session is active
- Path B detects key missing from S3 listing → deletes local copy. Correct.

### Agent creates then deletes a file in same invocation
- Not in `downloadedKeys` (was never downloaded), not on local disk → no action. Correct.

### Agent modifies a file then reverts to original content
- mtime changes → re-uploaded (false positive, but harmless). Acceptable.

### Concurrent invocations on same session
- Both modes reject concurrent requests (503 busy). Only one invocation runs at a time per session. No race condition on SyncState.

## Migration

- No data migration needed — SyncState is pure in-memory
- No API changes — InvocationPayload unchanged
- No infrastructure changes — same S3 bucket, same IAM policies
- Backward compatible: first request always takes Path A (identical to current behavior)
- Rollback: revert code change, system falls back to full sync on next VM/task restart
