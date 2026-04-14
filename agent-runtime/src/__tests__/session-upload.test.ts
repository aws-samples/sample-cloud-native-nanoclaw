import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises before importing the module under test
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from('content')),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn(),
  realpath: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import { incrementalSyncToS3 } from '../session.js';
import { SyncState } from '../sync-state.js';
import { readdir, stat } from 'fs/promises';
import type pino from 'pino';

const mockLogger: pino.Logger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as pino.Logger;

// ── S3Client mock ────────────────────────────────────────────────────

function createMockS3Client() {
  return {
    send: vi.fn(async (cmd: { constructor: { name: string }; input?: Record<string, unknown> }) => {
      const cmdName = cmd.constructor.name;

      if (cmdName === 'PutObjectCommand') {
        const key = (cmd.input as { Key?: string })?.Key ?? '';
        return { ETag: `"put-etag-${key}"` };
      }

      if (cmdName === 'DeleteObjectCommand') {
        return {};
      }

      return {};
    }),
  };
}

// ── Helper to extract S3 calls ────────────────────────────────────────

type MockCmd = { constructor: { name: string }; input?: Record<string, unknown> };

function getPutObjectKeys(s3: { send: ReturnType<typeof vi.fn> }): string[] {
  return (s3.send.mock.calls as [MockCmd][])
    .filter(([cmd]) => cmd.constructor.name === 'PutObjectCommand')
    .map(([cmd]) => (cmd.input as { Key?: string })?.Key ?? '');
}


// ── Tests ────────────────────────────────────────────────────────────

describe('incrementalSyncToS3', () => {
  let state: SyncState;

  const mockReaddir = readdir as unknown as ReturnType<typeof vi.fn>;
  const mockStat = stat as unknown as ReturnType<typeof vi.fn>;

  const basePaths = {
    sessionPath: 'user-1/bot-1/sessions/',
    botClaude: 'user-1/bot-1/CLAUDE.md',
    groupPrefix: 'user-1/bot-1/workspace/tg:123/',
  };

  beforeEach(() => {
    state = new SyncState();
    state.initialized = true;
    vi.clearAllMocks();

    // Default: readdir returns empty, stat throws ENOENT
    mockReaddir.mockResolvedValue([]);
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  // ── Test 1: Skips upload for unchanged files ──────────────────────

  it('skips upload for unchanged files (mtime + size match snapshot)', async () => {
    // Simulate a file in the session directory
    const sessionFile = {
      name: 'state.jsonl',
      parentPath: '/home/node/.claude',
      isFile: () => true,
      isSymbolicLink: () => false,
      isDirectory: () => false,
    };

    mockReaddir.mockImplementation(async (dir: string) => {
      if (dir === '/home/node/.claude') return [sessionFile];
      return [];
    });

    // Current stat matches the snapshot exactly
    mockStat.mockImplementation(async (path: string) => {
      if (path === '/home/node/.claude/state.jsonl') {
        return { mtimeMs: 1000, size: 500 };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    // Snapshot has the same values
    // We need to manually populate the snapshot via the internal Map
    // Since takeLocalSnapshot is async and scans real dirs, we use a workaround:
    // Access the private _localSnapshot directly for test purposes
    (state as unknown as { _localSnapshot: Map<string, { mtimeMs: number; size: number }> })._localSnapshot.set(
      '/home/node/.claude/state.jsonl',
      { mtimeMs: 1000, size: 500 },
    );

    const s3 = createMockS3Client();

    await incrementalSyncToS3(s3 as never, 'test-bucket', basePaths, mockLogger, state);

    // No PutObject should be called — file is unchanged
    const putKeys = getPutObjectKeys(s3);
    expect(putKeys).not.toContain('user-1/bot-1/sessions/state.jsonl');
  });

  // ── Test 2: Uploads files with changed mtime ──────────────────────

  it('uploads files with changed mtime', async () => {
    const sessionFile = {
      name: 'state.jsonl',
      parentPath: '/home/node/.claude',
      isFile: () => true,
      isSymbolicLink: () => false,
      isDirectory: () => false,
    };

    mockReaddir.mockImplementation(async (dir: string) => {
      if (dir === '/home/node/.claude') return [sessionFile];
      return [];
    });

    // Current stat has different mtime
    mockStat.mockImplementation(async (path: string) => {
      if (path === '/home/node/.claude/state.jsonl') {
        return { mtimeMs: 2000, size: 500 };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    // Snapshot has old mtime
    (state as unknown as { _localSnapshot: Map<string, { mtimeMs: number; size: number }> })._localSnapshot.set(
      '/home/node/.claude/state.jsonl',
      { mtimeMs: 1000, size: 500 },
    );

    const s3 = createMockS3Client();

    await incrementalSyncToS3(s3 as never, 'test-bucket', basePaths, mockLogger, state);

    // PutObject SHOULD be called — mtime differs
    const putKeys = getPutObjectKeys(s3);
    expect(putKeys).toContain('user-1/bot-1/sessions/state.jsonl');
  });

  // ── Test 3: Uploads files with changed size ───────────────────────

  it('uploads files with changed size', async () => {
    const sessionFile = {
      name: 'state.jsonl',
      parentPath: '/home/node/.claude',
      isFile: () => true,
      isSymbolicLink: () => false,
      isDirectory: () => false,
    };

    mockReaddir.mockImplementation(async (dir: string) => {
      if (dir === '/home/node/.claude') return [sessionFile];
      return [];
    });

    // Current stat has different size
    mockStat.mockImplementation(async (path: string) => {
      if (path === '/home/node/.claude/state.jsonl') {
        return { mtimeMs: 1000, size: 999 };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    // Snapshot has old size
    (state as unknown as { _localSnapshot: Map<string, { mtimeMs: number; size: number }> })._localSnapshot.set(
      '/home/node/.claude/state.jsonl',
      { mtimeMs: 1000, size: 500 },
    );

    const s3 = createMockS3Client();

    await incrementalSyncToS3(s3 as never, 'test-bucket', basePaths, mockLogger, state);

    // PutObject SHOULD be called — size differs
    const putKeys = getPutObjectKeys(s3);
    expect(putKeys).toContain('user-1/bot-1/sessions/state.jsonl');
  });

  // ── Test 4: Uploads new files (not in snapshot) ───────────────────

  it('uploads new files not in snapshot', async () => {
    const newFile = {
      name: 'new-file.txt',
      parentPath: '/workspace/group',
      isFile: () => true,
      isSymbolicLink: () => false,
      isDirectory: () => false,
    };

    mockReaddir.mockImplementation(async (dir: string) => {
      if (dir === '/workspace/group') return [newFile];
      return [];
    });

    // Stat returns valid info for the new file
    mockStat.mockImplementation(async (path: string) => {
      if (path === '/workspace/group/new-file.txt') {
        return { mtimeMs: 3000, size: 100 };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    // No snapshot entry for new-file.txt (snapshot is empty)

    const s3 = createMockS3Client();

    await incrementalSyncToS3(s3 as never, 'test-bucket', basePaths, mockLogger, state);

    // PutObject SHOULD be called — file not in snapshot
    const putKeys = getPutObjectKeys(s3);
    expect(putKeys).toContain('user-1/bot-1/workspace/tg:123/new-file.txt');
  });

  // Upload-side delete sync intentionally NOT implemented:
  // S3 is source of truth. Local file deletions by agent do NOT propagate to S3.
  // Files will be restored on next full sync (Path A).
});
