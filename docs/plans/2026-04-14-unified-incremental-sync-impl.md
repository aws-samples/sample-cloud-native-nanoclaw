# Unified S3 Incremental Sync — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace full-sync-every-request with incremental S3 sync that skips unchanged files on both download and upload, and properly synchronizes file deletions — for both AgentCore warm sessions and ECS dedicated tasks.

**Architecture:** A `SyncState` in-process singleton tracks S3 ETags (download optimization), a local stat snapshot (upload optimization), and downloaded key sets (delete sync). Path selection branches on session continuity (`syncState.initialized && currentSessionKey === sessionKey`), not deployment mode. Three paths: Full (first/switch), Incremental (same session), ForceNew (model change).

**Tech Stack:** TypeScript (ESM, strict), `@aws-sdk/client-s3` (HeadObjectCommand, DeleteObjectsCommand added), vitest for tests, pino for logging.

**Design doc:** `docs/plans/2026-04-14-unified-incremental-sync.md`

---

### Task 1: SyncState class

**Files:**
- Create: `agent-runtime/src/sync-state.ts`
- Test: `agent-runtime/src/__tests__/sync-state.test.ts`

This is a pure in-memory class with no AWS dependencies — fully unit-testable.

**Step 1: Write the failing tests**

```typescript
// agent-runtime/src/__tests__/sync-state.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncState } from '../sync-state.js';
import { stat, readdir } from 'fs/promises';

vi.mock('fs/promises', () => ({
  stat: vi.fn(),
  readdir: vi.fn(),
}));

const mockStat = vi.mocked(stat);
const mockReaddir = vi.mocked(readdir);

describe('SyncState', () => {
  let state: SyncState;

  beforeEach(() => {
    state = new SyncState();
    vi.clearAllMocks();
  });

  // --- initialized ---

  it('starts uninitialized', () => {
    expect(state.initialized).toBe(false);
  });

  // --- s3Etags ---

  it('records and retrieves ETags', () => {
    state.recordEtag('prefix/file.txt', '"abc123"');
    expect(state.getEtag('prefix/file.txt')).toBe('"abc123"');
    expect(state.getEtag('other')).toBeUndefined();
  });

  it('clearPrefix removes ETags under a prefix', () => {
    state.recordEtag('sessions/a.jsonl', '"e1"');
    state.recordEtag('sessions/b.jsonl', '"e2"');
    state.recordEtag('workspace/c.md', '"e3"');
    state.clearPrefix('sessions/');
    expect(state.getEtag('sessions/a.jsonl')).toBeUndefined();
    expect(state.getEtag('sessions/b.jsonl')).toBeUndefined();
    expect(state.getEtag('workspace/c.md')).toBe('"e3"');
  });

  // --- downloadedKeys ---

  it('records downloaded keys per prefix', () => {
    state.recordDownloadedKey('ws/', 'ws/file1.md');
    state.recordDownloadedKey('ws/', 'ws/file2.md');
    expect(state.getDownloadedKeys('ws/')).toEqual(new Set(['ws/file1.md', 'ws/file2.md']));
    expect(state.getDownloadedKeys('other/')).toEqual(new Set());
  });

  it('clearDownloadedKeys resets for next invocation', () => {
    state.recordDownloadedKey('ws/', 'ws/file1.md');
    state.clearDownloadedKeys();
    expect(state.getDownloadedKeys('ws/')).toEqual(new Set());
  });

  // --- localSnapshot ---

  it('takeLocalSnapshot records mtime and size', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'a.txt', parentPath: '/workspace/group', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
    ] as any);
    mockStat.mockResolvedValue({ mtimeMs: 1000, size: 42 } as any);

    await state.takeLocalSnapshot(['/workspace/group']);

    expect(state.getSnapshotEntry('/workspace/group/a.txt')).toEqual({ mtimeMs: 1000, size: 42 });
  });

  it('takeLocalSnapshot clears previous entries', async () => {
    // First snapshot
    mockReaddir.mockResolvedValue([
      { name: 'a.txt', parentPath: '/dir', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
    ] as any);
    mockStat.mockResolvedValue({ mtimeMs: 1000, size: 42 } as any);
    await state.takeLocalSnapshot(['/dir']);
    expect(state.getSnapshotEntry('/dir/a.txt')).toBeDefined();

    // Second snapshot with no files
    mockReaddir.mockResolvedValue([]);
    await state.takeLocalSnapshot(['/dir']);
    expect(state.getSnapshotEntry('/dir/a.txt')).toBeUndefined();
  });

  it('takeLocalSnapshot skips excluded dirs', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'pack.idx', parentPath: '/dir/.git/objects', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      { name: 'good.txt', parentPath: '/dir', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
    ] as any);
    mockStat.mockResolvedValue({ mtimeMs: 1, size: 1 } as any);

    await state.takeLocalSnapshot(['/dir']);

    expect(state.getSnapshotEntry('/dir/.git/objects/pack.idx')).toBeUndefined();
    expect(state.getSnapshotEntry('/dir/good.txt')).toBeDefined();
  });

  // --- reset ---

  it('reset clears all state', async () => {
    state.initialized = true;
    state.recordEtag('k', '"v"');
    state.recordDownloadedKey('p/', 'p/f');
    // snapshot needs mock
    mockReaddir.mockResolvedValue([
      { name: 'a.txt', parentPath: '/d', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
    ] as any);
    mockStat.mockResolvedValue({ mtimeMs: 1, size: 1 } as any);
    await state.takeLocalSnapshot(['/d']);

    state.reset();

    expect(state.initialized).toBe(false);
    expect(state.getEtag('k')).toBeUndefined();
    expect(state.getDownloadedKeys('p/')).toEqual(new Set());
    expect(state.getSnapshotEntry('/d/a.txt')).toBeUndefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -w agent-runtime -- --reporter verbose src/__tests__/sync-state.test.ts`
Expected: FAIL — `Cannot find module '../sync-state.js'`

**Step 3: Write SyncState implementation**

```typescript
// agent-runtime/src/sync-state.ts
import { stat, readdir } from 'fs/promises';
import { join, relative } from 'path';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
const EXCLUDED_FILES = new Set(['settings.json']);

function isExcludedPath(relPath: string): boolean {
  const segments = relPath.split('/');
  if (EXCLUDED_FILES.has(segments[segments.length - 1])) return true;
  return segments.some((seg) => EXCLUDED_DIRS.has(seg));
}

export class SyncState {
  initialized = false;

  private _s3Etags = new Map<string, string>();
  private _downloadedKeys = new Map<string, Set<string>>();
  private _localSnapshot = new Map<string, { mtimeMs: number; size: number }>();

  // --- S3 ETags ---

  recordEtag(key: string, etag: string): void {
    this._s3Etags.set(key, etag);
  }

  getEtag(key: string): string | undefined {
    return this._s3Etags.get(key);
  }

  clearPrefix(prefix: string): void {
    for (const key of this._s3Etags.keys()) {
      if (key.startsWith(prefix)) this._s3Etags.delete(key);
    }
  }

  // --- Downloaded keys ---

  recordDownloadedKey(prefix: string, key: string): void {
    let set = this._downloadedKeys.get(prefix);
    if (!set) {
      set = new Set();
      this._downloadedKeys.set(prefix, set);
    }
    set.add(key);
  }

  getDownloadedKeys(prefix: string): Set<string> {
    return this._downloadedKeys.get(prefix) ?? new Set();
  }

  clearDownloadedKeys(): void {
    this._downloadedKeys.clear();
  }

  // --- Local snapshot ---

  async takeLocalSnapshot(dirs: string[]): Promise<void> {
    this._localSnapshot.clear();

    for (const dir of dirs) {
      try {
        const entries = await readdir(dir, { recursive: true, withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const fullPath = join(entry.parentPath || (entry as any).path, entry.name);
          const rel = relative(dir, fullPath);
          if (isExcludedPath(rel)) continue;
          try {
            const s = await stat(fullPath);
            this._localSnapshot.set(fullPath, { mtimeMs: s.mtimeMs, size: s.size });
          } catch {
            // File may have been removed between readdir and stat
          }
        }
      } catch {
        // Directory may not exist
      }
    }
  }

  getSnapshotEntry(fullPath: string): { mtimeMs: number; size: number } | undefined {
    return this._localSnapshot.get(fullPath);
  }

  get snapshotKeys(): IterableIterator<string> {
    return this._localSnapshot.keys();
  }

  // --- Reset ---

  reset(): void {
    this.initialized = false;
    this._s3Etags.clear();
    this._downloadedKeys.clear();
    this._localSnapshot.clear();
  }
}

/** Module-level singleton. VM/task restart creates a fresh instance. */
export const syncState = new SyncState();
```

**Step 4: Run tests to verify they pass**

Run: `npm test -w agent-runtime -- --reporter verbose src/__tests__/sync-state.test.ts`
Expected: All 8 tests PASS

**Step 5: Typecheck**

Run: `npm run typecheck -w agent-runtime`
Expected: No errors

**Step 6: Commit**

```bash
git add agent-runtime/src/sync-state.ts agent-runtime/src/__tests__/sync-state.test.ts
git commit -m "feat(agent-runtime): add SyncState class for incremental S3 sync"
```

---

### Task 2: Augment existing download functions to record state

**Files:**
- Modify: `agent-runtime/src/session.ts:14` (add HeadObjectCommand import)
- Modify: `agent-runtime/src/session.ts:38-57` (`syncFromS3` — record ETags + downloadedKeys)
- Modify: `agent-runtime/src/session.ts:109-139` (`clearSessionDirectory` — clear syncState prefix)
- Modify: `agent-runtime/src/session.ts:145-163` (`syncMemoryOnlyFromS3` — record state)
- Modify: `agent-runtime/src/session.ts:199-221` (`downloadFile` — return ETag)
- Modify: `agent-runtime/src/session.ts:223-252` (`downloadDirectory` — collect ETags + keys)
- Modify: `agent-runtime/src/session.ts:254-272` (`uploadFile` — return ETag)
- Test: `agent-runtime/src/__tests__/session-sync.test.ts`

The key change: `downloadFile` and `downloadDirectory` now accept an optional `syncState` parameter and record ETags/keys into it. `uploadFile` returns the ETag from the PutObject response. This is backward compatible — passing no `syncState` preserves current behavior.

**Step 1: Write failing tests for state recording**

```typescript
// agent-runtime/src/__tests__/session-sync.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncFromS3, syncToS3 } from '../session.js';
import { SyncState } from '../sync-state.js';
import type { SyncPaths } from '../session.js';
import type pino from 'pino';

// Mock S3Client
const mockSend = vi.fn();
const mockS3 = { send: mockSend } as any;

const mockLogger: pino.Logger = {
  warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(),
} as unknown as pino.Logger;

// Mock fs/promises to prevent real filesystem access
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from('content')),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ mtimeMs: 1000, size: 7, isFile: () => true }),
    realpath: vi.fn().mockImplementation((p: string) => Promise.resolve(p)),
  };
});

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

const paths: SyncPaths = {
  sessionPath: 'u1/b1/sessions/g1/',
  botClaude: 'u1/b1/CLAUDE.md',
  groupPrefix: 'u1/b1/workspace/g1/',
};

describe('syncFromS3 with SyncState', () => {
  let state: SyncState;

  beforeEach(() => {
    state = new SyncState();
    vi.clearAllMocks();
  });

  it('records ETags from downloaded files into syncState', async () => {
    // ListObjectsV2 returns one file for session dir
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: 'u1/b1/sessions/g1/session.jsonl', ETag: '"etag-session"' }],
        IsTruncated: false,
      })
      // GetObject for session.jsonl
      .mockResolvedValueOnce({
        Body: { transformToByteArray: () => Buffer.from('session-data') },
        ETag: '"etag-session"',
      })
      // GetObject for botClaude
      .mockResolvedValueOnce({
        Body: { transformToByteArray: () => Buffer.from('# Bot') },
        ETag: '"etag-claude"',
      })
      // ListObjectsV2 for groupPrefix (empty)
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false });

    await syncFromS3(mockS3, 'bucket', paths, mockLogger, state);

    expect(state.getEtag('u1/b1/sessions/g1/session.jsonl')).toBe('"etag-session"');
    expect(state.getEtag('u1/b1/CLAUDE.md')).toBe('"etag-claude"');
  });

  it('records downloaded keys for delete sync', async () => {
    mockSend
      // ListObjectsV2 for session dir
      .mockResolvedValueOnce({
        Contents: [{ Key: 'u1/b1/sessions/g1/a.jsonl', ETag: '"e1"' }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: () => Buffer.from('data') },
        ETag: '"e1"',
      })
      // GetObject for botClaude
      .mockResolvedValueOnce({
        Body: { transformToByteArray: () => Buffer.from('# Bot') },
        ETag: '"ec"',
      })
      // ListObjectsV2 for groupPrefix
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false });

    await syncFromS3(mockS3, 'bucket', paths, mockLogger, state);

    const keys = state.getDownloadedKeys('u1/b1/sessions/g1/');
    expect(keys.has('u1/b1/sessions/g1/a.jsonl')).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -w agent-runtime -- --reporter verbose src/__tests__/session-sync.test.ts`
Expected: FAIL — `syncFromS3` does not accept 5th parameter

**Step 3: Modify session.ts download functions to record state**

Changes to `session.ts`:

1. Add import: `import { HeadObjectCommand } from '@aws-sdk/client-s3';` and `import type { SyncState } from './sync-state.js';`

2. `downloadFile` — capture and return ETag:
```typescript
async function downloadFile(
  s3: S3Client, bucket: string, key: string, localPath: string,
  logger: pino.Logger, state?: SyncState,
): Promise<void> {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (resp.Body) {
      await mkdir(dirname(localPath), { recursive: true });
      const bytes = await resp.Body.transformToByteArray();
      await writeFile(localPath, Buffer.from(bytes));
      if (state && resp.ETag) state.recordEtag(key, resp.ETag);
      logger.debug({ key, localPath }, 'Downloaded file');
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'NoSuchKey') {
      logger.debug({ key }, 'File not found in S3, skipping');
    } else {
      throw err;
    }
  }
}
```

3. `downloadDirectory` — pass state through, record downloadedKeys:
```typescript
async function downloadDirectory(
  s3: S3Client, bucket: string, prefix: string, localDir: string,
  logger: pino.Logger, state?: SyncState,
): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    for (const obj of resp.Contents ?? []) {
      if (!obj.Key) continue;
      const rel = obj.Key.slice(prefix.length).replace(/^\/+/, '');
      if (!rel) continue;
      if (isExcludedPath(rel)) continue;
      if (state && obj.ETag) state.recordEtag(obj.Key, obj.ETag);
      if (state) state.recordDownloadedKey(prefix, obj.Key);
      await downloadFile(s3, bucket, obj.Key, join(localDir, rel), logger, state);
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);
}
```

4. `syncFromS3` — accept optional `SyncState`, pass through:
```typescript
export async function syncFromS3(
  s3: S3Client, bucket: string, paths: SyncPaths, logger: pino.Logger,
  state?: SyncState,
): Promise<void> {
  await downloadDirectory(s3, bucket, paths.sessionPath, CLAUDE_DIR, logger, state);
  await downloadFile(s3, bucket, paths.botClaude, join(CLAUDE_DIR, 'CLAUDE.md'), logger, state);
  await downloadDirectory(s3, bucket, paths.groupPrefix, join(WORKSPACE_BASE, 'group'), logger, state);
  if (paths.learningsPrefix) {
    await downloadDirectory(s3, bucket, paths.learningsPrefix, join(WORKSPACE_BASE, 'learnings'), logger, state);
  }
}
```

5. `syncMemoryOnlyFromS3` — same pattern:
```typescript
export async function syncMemoryOnlyFromS3(
  s3: S3Client, bucket: string, paths: SyncPaths, logger: pino.Logger,
  state?: SyncState,
): Promise<void> {
  await downloadFile(s3, bucket, paths.botClaude, join(CLAUDE_DIR, 'CLAUDE.md'), logger, state);
  await downloadDirectory(s3, bucket, paths.groupPrefix, join(WORKSPACE_BASE, 'group'), logger, state);
  if (paths.learningsPrefix) {
    await downloadDirectory(s3, bucket, paths.learningsPrefix, join(WORKSPACE_BASE, 'learnings'), logger, state);
  }
}
```

6. `uploadFile` — record ETag from PutObject response:
```typescript
async function uploadFile(
  s3: S3Client, bucket: string, localPath: string, key: string,
  logger: pino.Logger, state?: SyncState,
): Promise<void> {
  try {
    const content = await readFile(localPath);
    const resp = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content }));
    if (state && resp.ETag) state.recordEtag(key, resp.ETag);
    logger.debug({ key, localPath }, 'Uploaded file');
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ localPath }, 'Local file not found, skipping upload');
    } else {
      throw err;
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -w agent-runtime -- --reporter verbose src/__tests__/session-sync.test.ts`
Expected: PASS

**Step 5: Run all existing tests to confirm no regressions**

Run: `npm test -w agent-runtime`
Expected: All tests PASS (the optional `state` param is backward compatible)

**Step 6: Typecheck**

Run: `npm run typecheck -w agent-runtime`
Expected: No errors

**Step 7: Commit**

```bash
git add agent-runtime/src/session.ts agent-runtime/src/__tests__/session-sync.test.ts
git commit -m "feat(agent-runtime): record ETags and downloadedKeys during S3 sync"
```

---

### Task 3: Incremental download functions (Path B)

**Files:**
- Modify: `agent-runtime/src/session.ts` (add `incrementalSyncFromS3`, `downloadDirectoryIncremental`, `downloadFileIfChanged`)
- Test: `agent-runtime/src/__tests__/session-incremental.test.ts`

**Step 1: Write failing tests**

```typescript
// agent-runtime/src/__tests__/session-incremental.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { incrementalSyncFromS3 } from '../session.js';
import { SyncState } from '../sync-state.js';
import type { SyncPaths } from '../session.js';
import type pino from 'pino';
import { unlink } from 'fs/promises';

const mockSend = vi.fn();
const mockS3 = { send: mockSend } as any;

const mockLogger: pino.Logger = {
  warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(),
} as unknown as pino.Logger;

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from('content')),
    unlink: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ mtimeMs: 1000, size: 7, isFile: () => true }),
    realpath: vi.fn().mockImplementation((p: string) => Promise.resolve(p)),
  };
});

vi.mock('fs', () => ({ existsSync: vi.fn().mockReturnValue(true) }));

const mockUnlink = vi.mocked(unlink);

const paths: SyncPaths = {
  sessionPath: 'u1/b1/sessions/g1/',
  botClaude: 'u1/b1/CLAUDE.md',
  groupPrefix: 'u1/b1/workspace/g1/',
};

describe('incrementalSyncFromS3', () => {
  let state: SyncState;

  beforeEach(() => {
    state = new SyncState();
    state.initialized = true;
    vi.clearAllMocks();
  });

  it('skips session download entirely', async () => {
    // HeadObject for botClaude (unchanged)
    mockSend
      .mockResolvedValueOnce({ ETag: '"etag-claude"' }) // HeadObject botClaude
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false }); // ListObjectsV2 groupPrefix

    state.recordEtag('u1/b1/CLAUDE.md', '"etag-claude"');

    await incrementalSyncFromS3(mockS3, 'bucket', paths, mockLogger, state);

    // Verify no ListObjectsV2 was called for sessionPath
    const calls = mockSend.mock.calls;
    const listCalls = calls.filter((c) => c[0].constructor.name === 'ListObjectsV2Command');
    for (const [cmd] of listCalls) {
      expect(cmd.input.Prefix).not.toBe('u1/b1/sessions/g1/');
    }
  });

  it('re-downloads botClaude when ETag changes', async () => {
    state.recordEtag('u1/b1/CLAUDE.md', '"old-etag"');

    mockSend
      // HeadObject botClaude — different ETag
      .mockResolvedValueOnce({ ETag: '"new-etag"' })
      // GetObject botClaude — re-download
      .mockResolvedValueOnce({
        Body: { transformToByteArray: () => Buffer.from('# Updated Bot') },
        ETag: '"new-etag"',
      })
      // ListObjectsV2 groupPrefix (empty)
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false });

    await incrementalSyncFromS3(mockS3, 'bucket', paths, mockLogger, state);

    expect(state.getEtag('u1/b1/CLAUDE.md')).toBe('"new-etag"');
  });

  it('deletes local file when S3 key disappears', async () => {
    // Previously downloaded a file from groupPrefix
    state.recordEtag('u1/b1/workspace/g1/old-memory.md', '"e-old"');
    state.recordDownloadedKey('u1/b1/workspace/g1/', 'u1/b1/workspace/g1/old-memory.md');

    mockSend
      .mockResolvedValueOnce({ ETag: '"etag-claude"' }) // HeadObject botClaude (unchanged)
      // ListObjectsV2 groupPrefix — old-memory.md is gone
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false });

    state.recordEtag('u1/b1/CLAUDE.md', '"etag-claude"');

    await incrementalSyncFromS3(mockS3, 'bucket', paths, mockLogger, state);

    // Should have called unlink for the disappeared file
    expect(mockUnlink).toHaveBeenCalledWith(
      expect.stringContaining('old-memory.md'),
    );
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -w agent-runtime -- --reporter verbose src/__tests__/session-incremental.test.ts`
Expected: FAIL — `incrementalSyncFromS3` not exported

**Step 3: Implement incremental download functions**

Add to `session.ts`:

```typescript
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { unlink } from 'fs/promises';
import type { SyncState } from './sync-state.js';

/**
 * HeadObject ETag check for a single file. Re-downloads only if changed.
 */
async function downloadFileIfChanged(
  s3: S3Client, bucket: string, key: string, localPath: string,
  logger: pino.Logger, state: SyncState,
): Promise<void> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const currentEtag = head.ETag;
    if (currentEtag && currentEtag === state.getEtag(key)) {
      logger.debug({ key }, 'File unchanged (ETag match), skipping download');
      return;
    }
    // ETag changed or new — full download
    await downloadFile(s3, bucket, key, localPath, logger, state);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'NotFound') {
      logger.debug({ key }, 'File not found in S3 (HeadObject), skipping');
    } else {
      throw err;
    }
  }
}

/**
 * Incremental directory download: ListObjectsV2 + ETag comparison.
 * Downloads changed/new files, deletes local files whose S3 keys disappeared.
 */
async function downloadDirectoryIncremental(
  s3: S3Client, bucket: string, prefix: string, localDir: string,
  logger: pino.Logger, state: SyncState,
): Promise<void> {
  const previousKeys = new Set(state.getDownloadedKeys(prefix));
  const currentKeys = new Set<string>();

  let continuationToken: string | undefined;
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    for (const obj of resp.Contents ?? []) {
      if (!obj.Key || !obj.ETag) continue;
      const rel = obj.Key.slice(prefix.length).replace(/^\/+/, '');
      if (!rel) continue;
      if (isExcludedPath(rel)) continue;

      currentKeys.add(obj.Key);
      state.recordDownloadedKey(prefix, obj.Key);

      const prevEtag = state.getEtag(obj.Key);
      if (prevEtag === obj.ETag) {
        // Unchanged — skip download
        continue;
      }
      // Changed or new — download
      state.recordEtag(obj.Key, obj.ETag);
      await downloadFile(s3, bucket, obj.Key, join(localDir, rel), logger, state);
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  // Delete local files whose S3 keys disappeared (e.g., web console deletion)
  for (const prevKey of previousKeys) {
    if (!currentKeys.has(prevKey)) {
      const rel = prevKey.slice(prefix.length).replace(/^\/+/, '');
      if (!rel) continue;
      const localPath = join(localDir, rel);
      try {
        await unlink(localPath);
        logger.info({ key: prevKey, localPath }, 'Deleted local file (S3 key removed)');
      } catch {
        // File may already be gone locally
      }
      state.recordEtag(prevKey, ''); // Clear stale ETag
    }
  }
}

/**
 * Path B: Incremental download for same-session subsequent requests.
 * Skips session state download entirely. ETag-checks memory files.
 */
export async function incrementalSyncFromS3(
  s3: S3Client, bucket: string, paths: SyncPaths, logger: pino.Logger,
  state: SyncState,
): Promise<void> {
  // 1. Skip session state download — local is authoritative

  // 2. HeadObject check botClaude — re-download only if changed
  await downloadFileIfChanged(
    s3, bucket, paths.botClaude, join(CLAUDE_DIR, 'CLAUDE.md'), logger, state,
  );

  // 3. Incremental download group workspace
  // Clear previous downloadedKeys for this prefix before rebuilding
  state.clearDownloadedKeys();
  await downloadDirectoryIncremental(
    s3, bucket, paths.groupPrefix, join(WORKSPACE_BASE, 'group'), logger, state,
  );

  // 4. Incremental download learnings
  if (paths.learningsPrefix) {
    await downloadDirectoryIncremental(
      s3, bucket, paths.learningsPrefix, join(WORKSPACE_BASE, 'learnings'), logger, state,
    );
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -w agent-runtime -- --reporter verbose src/__tests__/session-incremental.test.ts`
Expected: All 3 tests PASS

**Step 5: Run all tests**

Run: `npm test -w agent-runtime`
Expected: All tests PASS

**Step 6: Typecheck**

Run: `npm run typecheck -w agent-runtime`
Expected: No errors

**Step 7: Commit**

```bash
git add agent-runtime/src/session.ts agent-runtime/src/__tests__/session-incremental.test.ts
git commit -m "feat(agent-runtime): add incremental download with ETag comparison and delete sync"
```

---

### Task 4: Incremental upload with snapshot diff and delete sync

**Files:**
- Modify: `agent-runtime/src/session.ts` (add `incrementalSyncToS3`)
- Test: `agent-runtime/src/__tests__/session-upload.test.ts`

**Step 1: Write failing tests**

```typescript
// agent-runtime/src/__tests__/session-upload.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { incrementalSyncToS3 } from '../session.js';
import { SyncState } from '../sync-state.js';
import type { SyncPaths } from '../session.js';
import type pino from 'pino';

const mockSend = vi.fn();
const mockS3 = { send: mockSend } as any;

const mockLogger: pino.Logger = {
  warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(),
} as unknown as pino.Logger;

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from('content')),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ mtimeMs: 2000, size: 100, isFile: () => true }),
    realpath: vi.fn().mockImplementation((p: string) => Promise.resolve(p)),
  };
});

vi.mock('fs', () => ({ existsSync: vi.fn().mockReturnValue(true) }));

import { readdir, stat, readFile } from 'fs/promises';
const mockReaddir = vi.mocked(readdir);
const mockStatFn = vi.mocked(stat);
const mockReadFile = vi.mocked(readFile);

const paths: SyncPaths = {
  sessionPath: 'u1/b1/sessions/g1/',
  botClaude: 'u1/b1/CLAUDE.md',
  groupPrefix: 'u1/b1/workspace/g1/',
};

describe('incrementalSyncToS3', () => {
  let state: SyncState;

  beforeEach(() => {
    state = new SyncState();
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ ETag: '"new-etag"' }); // Default PutObject response
  });

  it('skips upload for files with unchanged mtime and size', async () => {
    // Snapshot recorded file with mtime=1000, size=42
    state['_localSnapshot'].set('/home/node/.claude/session.jsonl', { mtimeMs: 1000, size: 42 });

    // Current stat returns same values
    mockReaddir.mockResolvedValue([
      { name: 'session.jsonl', parentPath: '/home/node/.claude', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
    ] as any);
    mockStatFn.mockResolvedValue({ mtimeMs: 1000, size: 42 } as any);

    await incrementalSyncToS3(mockS3, 'bucket', paths, mockLogger, state);

    // No PutObject calls for the unchanged file
    const putCalls = mockSend.mock.calls.filter(
      (c) => c[0].constructor.name === 'PutObjectCommand',
    );
    expect(putCalls).toHaveLength(0);
  });

  it('uploads files with changed mtime', async () => {
    state['_localSnapshot'].set('/home/node/.claude/session.jsonl', { mtimeMs: 1000, size: 42 });

    mockReaddir.mockResolvedValue([
      { name: 'session.jsonl', parentPath: '/home/node/.claude', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
    ] as any);
    // mtime changed
    mockStatFn.mockResolvedValue({ mtimeMs: 2000, size: 42 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('updated') as any);

    await incrementalSyncToS3(mockS3, 'bucket', paths, mockLogger, state);

    const putCalls = mockSend.mock.calls.filter(
      (c) => c[0].constructor.name === 'PutObjectCommand',
    );
    expect(putCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('deletes S3 object when local file was deleted by agent', async () => {
    // A file was downloaded from S3
    state.recordDownloadedKey('u1/b1/workspace/g1/', 'u1/b1/workspace/g1/old-file.md');

    // Local readdir returns nothing (agent deleted it)
    mockReaddir.mockResolvedValue([]);

    // existsSync returns false for the deleted file
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockImplementation((p) => {
      if (String(p).includes('old-file.md')) return false;
      return true;
    });

    await incrementalSyncToS3(mockS3, 'bucket', paths, mockLogger, state);

    const deleteCalls = mockSend.mock.calls.filter(
      (c) => c[0].constructor.name === 'DeleteObjectCommand',
    );
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    expect(deleteCalls[0][0].input.Key).toBe('u1/b1/workspace/g1/old-file.md');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -w agent-runtime -- --reporter verbose src/__tests__/session-upload.test.ts`
Expected: FAIL — `incrementalSyncToS3` not exported

**Step 3: Implement incremental upload**

Add to `session.ts`:

```typescript
/**
 * Incremental upload: compare local files against snapshot, upload only changed files.
 * Also handles delete sync: files downloaded from S3 but deleted locally → DeleteObject.
 */
export async function incrementalSyncToS3(
  s3: S3Client, bucket: string, paths: SyncPaths, logger: pino.Logger,
  state: SyncState,
): Promise<void> {
  // Upload each sync directory incrementally
  await uploadDirectoryIncremental(s3, bucket, CLAUDE_DIR, paths.sessionPath, logger, state);
  await uploadFileIfChanged(s3, bucket, join(CLAUDE_DIR, 'CLAUDE.md'), paths.botClaude, logger, state);
  await uploadDirectoryIncremental(s3, bucket, join(WORKSPACE_BASE, 'group'), paths.groupPrefix, logger, state);
  if (paths.learningsPrefix) {
    await uploadDirectoryIncremental(s3, bucket, join(WORKSPACE_BASE, 'learnings'), paths.learningsPrefix, logger, state);
  }

  // Delete sync: check if any downloaded files were deleted locally
  for (const [prefix, keys] of [
    [paths.sessionPath, state.getDownloadedKeys(paths.sessionPath)] as const,
    [paths.groupPrefix, state.getDownloadedKeys(paths.groupPrefix)] as const,
    ...(paths.learningsPrefix
      ? [[paths.learningsPrefix, state.getDownloadedKeys(paths.learningsPrefix)] as const]
      : []),
  ]) {
    for (const s3Key of keys) {
      const rel = s3Key.slice(prefix.length).replace(/^\/+/, '');
      if (!rel) continue;
      const localDir = prefix === paths.sessionPath
        ? CLAUDE_DIR
        : prefix === paths.groupPrefix
          ? join(WORKSPACE_BASE, 'group')
          : join(WORKSPACE_BASE, 'learnings');
      const localPath = join(localDir, rel);
      if (!existsSync(localPath)) {
        await deleteS3Object(s3, bucket, s3Key, logger);
        logger.info({ s3Key }, 'Deleted S3 object (local file removed by agent)');
      }
    }
  }
}

/** Upload a single file only if snapshot shows it changed. */
async function uploadFileIfChanged(
  s3: S3Client, bucket: string, localPath: string, key: string,
  logger: pino.Logger, state: SyncState,
): Promise<void> {
  try {
    const s = await stat(localPath);
    const snap = state.getSnapshotEntry(localPath);
    if (snap && snap.mtimeMs === s.mtimeMs && snap.size === s.size) {
      logger.debug({ key }, 'File unchanged (snapshot match), skipping upload');
      return;
    }
    await uploadFile(s3, bucket, localPath, key, logger, state);
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ localPath }, 'Local file not found, skipping upload');
    } else {
      throw err;
    }
  }
}

/** Walk directory, upload only files that changed vs snapshot. */
async function uploadDirectoryIncremental(
  s3: S3Client, bucket: string, localDir: string, prefix: string,
  logger: pino.Logger, state: SyncState,
): Promise<void> {
  try {
    const entries = await readdir(localDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = join(entry.parentPath || (entry as any).path, entry.name);
      const rel = relative(localDir, fullPath);
      if (isExcludedPath(rel)) continue;

      const s = await stat(fullPath);
      const snap = state.getSnapshotEntry(fullPath);
      if (snap && snap.mtimeMs === s.mtimeMs && snap.size === s.size) {
        continue; // Unchanged
      }
      // Changed or new — upload
      await uploadFile(s3, bucket, fullPath, prefix + rel, logger, state);
    }
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ localDir }, 'Directory not found, skipping upload');
    } else {
      throw err;
    }
  }
}
```

Add `import { existsSync } from 'fs';` and `import { relative } from 'path';` if not already imported (they are — `existsSync` at line 15, `relative` at line 17).

**Step 4: Run tests to verify they pass**

Run: `npm test -w agent-runtime -- --reporter verbose src/__tests__/session-upload.test.ts`
Expected: All 3 tests PASS

**Step 5: Run all tests**

Run: `npm test -w agent-runtime`
Expected: All tests PASS

**Step 6: Typecheck**

Run: `npm run typecheck -w agent-runtime`
Expected: No errors

**Step 7: Commit**

```bash
git add agent-runtime/src/session.ts agent-runtime/src/__tests__/session-upload.test.ts
git commit -m "feat(agent-runtime): add incremental upload with snapshot diff and delete sync"
```

---

### Task 5: Wire sync paths into agent.ts

**Files:**
- Modify: `agent-runtime/src/agent.ts:35` (import `incrementalSyncFromS3`, `incrementalSyncToS3`)
- Modify: `agent-runtime/src/agent.ts:120-121` (import and use `syncState`)
- Modify: `agent-runtime/src/agent.ts:205-394` (`_handleInvocation` — path selection logic)

This is the integration task. No new test file needed — the behavior is tested via the unit tests in Tasks 1-4. We verify with typecheck and existing tests.

**Step 1: Add imports to agent.ts**

At `agent-runtime/src/agent.ts:35`, change:

```typescript
// Before:
import { syncFromS3, syncToS3, clearSessionDirectory, syncMemoryOnlyFromS3, downloadSkills, type SyncPaths } from './session.js';

// After:
import {
  syncFromS3, syncToS3,
  clearSessionDirectory, syncMemoryOnlyFromS3,
  incrementalSyncFromS3, incrementalSyncToS3,
  downloadSkills, type SyncPaths,
} from './session.js';
import { syncState } from './sync-state.js';
```

**Step 2: Replace the sync orchestration in `_handleInvocation`**

Replace lines 211-259 (session switch detection through sync) and line 384-386 (upload) with the three-path logic. The key structural change:

```typescript
// agent-runtime/src/agent.ts — inside _handleInvocation

  const sessionKey = `${botId}#${groupJid}`;
  const forceNewSession = !!payload.forceNewSession;
  const isSessionContinuation = syncState.initialized
    && currentSessionKey === sessionKey
    && !forceNewSession;

  if (currentSessionKey && currentSessionKey !== sessionKey) {
    logger.info(
      { previousSession: currentSessionKey, newSession: sessionKey },
      'Session switch detected',
    );
  }
  currentSessionKey = sessionKey;

  // 1. Get scoped credentials
  logger.info({ botId, userId }, 'Acquiring scoped credentials');
  const scopedClients = await getScopedClients(userId, botId);
  const s3 = scopedClients.s3;

  const syncPaths: SyncPaths = {
    sessionPath,
    botClaude: memoryPaths.botClaude,
    groupPrefix: memoryPaths.groupPrefix,
    learningsPrefix: memoryPaths.learnings,
  };

  // 2. Sync session and memory from S3 → local workspace (three paths)
  if (forceNewSession) {
    // Path C: model/provider changed → full clean + session reset
    logger.info({ botId, groupJid }, 'Path C: forceNewSession — full clean + session reset');
    await cleanLocalWorkspace();
    if (payload.skills?.length) {
      await downloadSkills(s3, SESSION_BUCKET, payload.skills, logger);
    }
    await clearSessionDirectory(s3, SESSION_BUCKET, sessionPath, logger);
    syncState.clearPrefix(sessionPath);
    syncState.clearDownloadedKeys();
    await syncMemoryOnlyFromS3(s3, SESSION_BUCKET, syncPaths, logger, syncState);
  } else if (isSessionContinuation) {
    // Path B: same session, subsequent request → incremental
    logger.info({ botId, groupJid }, 'Path B: incremental sync (session continuation)');
    if (payload.skills?.length) {
      await downloadSkills(s3, SESSION_BUCKET, payload.skills, logger);
    }
    await incrementalSyncFromS3(s3, SESSION_BUCKET, syncPaths, logger, syncState);
  } else {
    // Path A: first request or session switch → full clean + full sync
    logger.info({ botId, groupJid }, 'Path A: full sync (first request or session switch)');
    syncState.reset();
    await cleanLocalWorkspace();
    if (payload.skills?.length) {
      await downloadSkills(s3, SESSION_BUCKET, payload.skills, logger);
    }
    await syncFromS3(s3, SESSION_BUCKET, syncPaths, logger, syncState);
  }

  // Snapshot local state before agent runs (for upload optimization)
  const SYNC_DIRS = [
    CLAUDE_DIR,
    join(WORKSPACE_BASE, 'group'),
    join(WORKSPACE_BASE, 'learnings'),
  ];
  await syncState.takeLocalSnapshot(SYNC_DIRS);
  syncState.initialized = true;
```

For the upload (after the agent query, around line 384-386), replace:

```typescript
  // Before:
  logger.info('Syncing session back to S3');
  await syncToS3(s3, SESSION_BUCKET, syncPaths, logger);

  // After:
  logger.info('Syncing session back to S3');
  await incrementalSyncToS3(s3, SESSION_BUCKET, syncPaths, logger, syncState);
```

Also add the import for `join` from `path` if not already at the top (it's already imported via `import path from 'path'` at line 24, used as `path.join` — use the same pattern or add `const { join } = path;` as a local alias near the sync code, or use `path.join` directly).

**Step 3: Remove now-dead code**

The unconditional `await cleanLocalWorkspace()` at line 239 and the separate skills download + sync blocks (lines 241-259) are replaced by the three-path block above. Remove them.

The `await syncToS3(...)` at line 386 is replaced by `await incrementalSyncToS3(...)`.

**Step 4: Typecheck**

Run: `npm run typecheck -w agent-runtime`
Expected: No errors

**Step 5: Run all tests**

Run: `npm test -w agent-runtime`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add agent-runtime/src/agent.ts
git commit -m "feat(agent-runtime): wire three-path sync into invocation handler"
```

---

### Task 6: End-to-end integration verification

**Files:**
- Test: `agent-runtime/src/__tests__/sync-integration.test.ts`

This test verifies the full path selection logic without real S3, focusing on which sync path is taken based on `syncState` + `currentSessionKey`.

**Step 1: Write the integration test**

```typescript
// agent-runtime/src/__tests__/sync-integration.test.ts
import { describe, it, expect } from 'vitest';
import { SyncState } from '../sync-state.js';

/**
 * Integration-level test for path selection logic.
 * Verifies the branching conditions without calling real sync functions.
 */
describe('sync path selection', () => {
  function selectPath(
    syncState: SyncState,
    currentSessionKey: string | undefined,
    newSessionKey: string,
    forceNewSession: boolean,
  ): 'A' | 'B' | 'C' {
    if (forceNewSession) return 'C';
    const isSessionContinuation = syncState.initialized
      && currentSessionKey === newSessionKey
      && !forceNewSession;
    if (isSessionContinuation) return 'B';
    return 'A';
  }

  it('selects Path A on first request (uninitialized)', () => {
    const state = new SyncState();
    expect(selectPath(state, undefined, 'bot1#group1', false)).toBe('A');
  });

  it('selects Path A on session switch', () => {
    const state = new SyncState();
    state.initialized = true;
    expect(selectPath(state, 'bot1#group1', 'bot2#group2', false)).toBe('A');
  });

  it('selects Path B on same-session subsequent request', () => {
    const state = new SyncState();
    state.initialized = true;
    expect(selectPath(state, 'bot1#group1', 'bot1#group1', false)).toBe('B');
  });

  it('selects Path C when forceNewSession is true', () => {
    const state = new SyncState();
    state.initialized = true;
    expect(selectPath(state, 'bot1#group1', 'bot1#group1', true)).toBe('C');
  });

  it('selects Path C over Path B even for same session', () => {
    const state = new SyncState();
    state.initialized = true;
    expect(selectPath(state, 'bot1#group1', 'bot1#group1', true)).toBe('C');
  });

  it('selects Path A when initialized but currentSessionKey is undefined', () => {
    const state = new SyncState();
    state.initialized = true;
    expect(selectPath(state, undefined, 'bot1#group1', false)).toBe('A');
  });
});
```

**Step 2: Run tests**

Run: `npm test -w agent-runtime -- --reporter verbose src/__tests__/sync-integration.test.ts`
Expected: All 6 tests PASS

**Step 3: Run full test suite**

Run: `npm test -w agent-runtime`
Expected: All tests PASS

**Step 4: Typecheck the entire agent-runtime package**

Run: `npm run typecheck -w agent-runtime`
Expected: No errors

**Step 5: Commit**

```bash
git add agent-runtime/src/__tests__/sync-integration.test.ts
git commit -m "test(agent-runtime): add sync path selection integration tests"
```

---

### Task 7: Final build verification and cleanup

**Step 1: Build shared (dependency)**

Run: `npm run build -w shared`
Expected: Clean build

**Step 2: Build agent-runtime**

Run: `npm run build -w agent-runtime`
Expected: Clean build, `dist/` contains `sync-state.js`

**Step 3: Run all agent-runtime tests**

Run: `npm test -w agent-runtime`
Expected: All tests PASS

**Step 4: Verify the old full-sync functions still exist (backward compatibility)**

Check: `syncFromS3` and `syncToS3` are still exported and unchanged when called without `state` parameter. `uploadDirectory` still handles symlinks correctly (not broken by refactor).

Run: `npm run typecheck -w agent-runtime`
Expected: No errors

**Step 5: Update design doc status**

Modify `docs/plans/2026-04-14-unified-incremental-sync.md` line 2:

```markdown
**Status:** Implemented
```

**Step 6: Commit**

```bash
git add docs/plans/2026-04-14-unified-incremental-sync.md
git commit -m "docs: mark unified incremental sync as implemented"
```
