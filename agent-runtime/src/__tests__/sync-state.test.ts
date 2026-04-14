import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises before importing the module under test
vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
}));

import { syncState } from '../sync-state.js';
import { readdir, stat } from 'fs/promises';
import type { Stats } from 'fs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dirent<NonSharedBuffer> is impractical in tests
const mockReaddir = readdir as any;
const mockStat = stat as unknown as ReturnType<typeof vi.fn>;

function makeDirent(name: string, parentPath: string, isFile: boolean) {
  return {
    name,
    parentPath,
    path: parentPath,
    isFile: () => isFile,
    isDirectory: () => !isFile,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function makeStats(mtimeMs: number, size: number): Stats {
  return { mtimeMs, size } as Stats;
}

beforeEach(() => {
  syncState.reset();
  vi.resetAllMocks();
});

describe('SyncState', () => {
  // ── initialized flag ───────────────────────────────────────────

  it('initialized starts false', () => {
    expect(syncState.initialized).toBe(false);
  });

  it('initialized can be set to true', () => {
    syncState.initialized = true;
    expect(syncState.initialized).toBe(true);
  });

  // ── ETag tracking ──────────────────────────────────────────────

  describe('recordEtag / getEtag', () => {
    it('round-trips an ETag for a given key', () => {
      syncState.recordEtag('user-1/bot-1/sessions/file.jsonl', '"abc123"');
      expect(syncState.getEtag('user-1/bot-1/sessions/file.jsonl')).toBe('"abc123"');
    });

    it('returns undefined for unrecorded key', () => {
      expect(syncState.getEtag('unknown/key')).toBeUndefined();
    });

    it('overwrites an existing ETag', () => {
      syncState.recordEtag('key', '"v1"');
      syncState.recordEtag('key', '"v2"');
      expect(syncState.getEtag('key')).toBe('"v2"');
    });
  });

  // ── clearPrefix ────────────────────────────────────────────────

  describe('clearPrefix', () => {
    it('removes ETags under a prefix but keeps others', () => {
      syncState.recordEtag('session/a.json', '"1"');
      syncState.recordEtag('session/b.json', '"2"');
      syncState.recordEtag('workspace/c.md', '"3"');

      syncState.clearPrefix('session/');

      expect(syncState.getEtag('session/a.json')).toBeUndefined();
      expect(syncState.getEtag('session/b.json')).toBeUndefined();
      expect(syncState.getEtag('workspace/c.md')).toBe('"3"');
    });

    it('does nothing when no keys match', () => {
      syncState.recordEtag('a', '"1"');
      syncState.clearPrefix('zzz/');
      expect(syncState.getEtag('a')).toBe('"1"');
    });
  });

  // ── Downloaded keys tracking ───────────────────────────────────

  describe('recordDownloadedKey / getDownloadedKeys', () => {
    it('records and retrieves keys per prefix', () => {
      syncState.recordDownloadedKey('session/', 'session/a.json');
      syncState.recordDownloadedKey('session/', 'session/b.json');
      syncState.recordDownloadedKey('workspace/', 'workspace/c.md');

      const sessionKeys = syncState.getDownloadedKeys('session/');
      expect(sessionKeys).toContain('session/a.json');
      expect(sessionKeys).toContain('session/b.json');
      expect(sessionKeys).toHaveLength(2);

      const wsKeys = syncState.getDownloadedKeys('workspace/');
      expect(wsKeys).toContain('workspace/c.md');
      expect(wsKeys).toHaveLength(1);
    });

    it('returns empty array for unrecorded prefix', () => {
      expect(syncState.getDownloadedKeys('unknown/')).toEqual([]);
    });

    it('deduplicates keys within the same prefix', () => {
      syncState.recordDownloadedKey('p/', 'p/x');
      syncState.recordDownloadedKey('p/', 'p/x');
      expect(syncState.getDownloadedKeys('p/')).toHaveLength(1);
    });
  });

  // ── clearDownloadedKeys ────────────────────────────────────────

  describe('clearDownloadedKeys', () => {
    it('resets downloaded keys for a specific prefix', () => {
      syncState.recordDownloadedKey('a/', 'a/1');
      syncState.recordDownloadedKey('b/', 'b/1');

      syncState.clearDownloadedKeys('a/');

      expect(syncState.getDownloadedKeys('a/')).toEqual([]);
      expect(syncState.getDownloadedKeys('b/')).toHaveLength(1);
    });
  });

  // ── takeLocalSnapshot ──────────────────────────────────────────

  describe('takeLocalSnapshot', () => {
    it('records mtime and size from stat()', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('file.txt', '/workspace/group', true),
      ]);
      mockStat.mockResolvedValue(makeStats(1000, 256));

      await syncState.takeLocalSnapshot(['/workspace/group']);

      const entry = syncState.getSnapshotEntry('/workspace/group/file.txt');
      expect(entry).toEqual({ mtimeMs: 1000, size: 256 });
    });

    it('clears previous snapshot entries', async () => {
      // First snapshot
      mockReaddir.mockResolvedValue([
        makeDirent('old.txt', '/dir1', true),
      ]);
      mockStat.mockResolvedValue(makeStats(100, 10));
      await syncState.takeLocalSnapshot(['/dir1']);
      expect(syncState.getSnapshotEntry('/dir1/old.txt')).toBeDefined();

      // Second snapshot — different dir, old entries cleared
      mockReaddir.mockResolvedValue([
        makeDirent('new.txt', '/dir2', true),
      ]);
      mockStat.mockResolvedValue(makeStats(200, 20));
      await syncState.takeLocalSnapshot(['/dir2']);

      expect(syncState.getSnapshotEntry('/dir1/old.txt')).toBeUndefined();
      expect(syncState.getSnapshotEntry('/dir2/new.txt')).toEqual({ mtimeMs: 200, size: 20 });
    });

    it('skips excluded dirs (.git, node_modules, .venv, __pycache__)', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('config', '/workspace/group/.git', true),
        makeDirent('index.js', '/workspace/group/node_modules', true),
        makeDirent('lib.pyc', '/workspace/group/__pycache__', true),
        makeDirent('env.cfg', '/workspace/group/.venv', true),
        makeDirent('ok.txt', '/workspace/group', true),
      ]);
      mockStat.mockResolvedValue(makeStats(500, 50));

      await syncState.takeLocalSnapshot(['/workspace/group']);

      expect(syncState.getSnapshotEntry('/workspace/group/.git/config')).toBeUndefined();
      expect(syncState.getSnapshotEntry('/workspace/group/node_modules/index.js')).toBeUndefined();
      expect(syncState.getSnapshotEntry('/workspace/group/__pycache__/lib.pyc')).toBeUndefined();
      expect(syncState.getSnapshotEntry('/workspace/group/.venv/env.cfg')).toBeUndefined();
      expect(syncState.getSnapshotEntry('/workspace/group/ok.txt')).toEqual({ mtimeMs: 500, size: 50 });
    });

    it('skips excluded files (settings.json)', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('settings.json', '/workspace/group', true),
        makeDirent('data.json', '/workspace/group', true),
      ]);
      mockStat.mockResolvedValue(makeStats(300, 30));

      await syncState.takeLocalSnapshot(['/workspace/group']);

      expect(syncState.getSnapshotEntry('/workspace/group/settings.json')).toBeUndefined();
      expect(syncState.getSnapshotEntry('/workspace/group/data.json')).toEqual({ mtimeMs: 300, size: 30 });
    });

    it('handles multiple dirs in one call', async () => {
      mockReaddir.mockImplementation(async (dir: any) => {
        if (dir === '/dir-a') {
          return [makeDirent('a.txt', '/dir-a', true)];
        }
        return [makeDirent('b.txt', '/dir-b', true)];
      });
      mockStat.mockImplementation(async (p: any) => {
        if (String(p).includes('a.txt')) return makeStats(1, 10);
        return makeStats(2, 20);
      });

      await syncState.takeLocalSnapshot(['/dir-a', '/dir-b']);

      expect(syncState.getSnapshotEntry('/dir-a/a.txt')).toEqual({ mtimeMs: 1, size: 10 });
      expect(syncState.getSnapshotEntry('/dir-b/b.txt')).toEqual({ mtimeMs: 2, size: 20 });
    });

    it('silently skips when dir does not exist (ENOENT)', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      mockReaddir.mockRejectedValue(err);

      // Should not throw
      await syncState.takeLocalSnapshot(['/nonexistent']);
      expect(syncState.snapshotKeys).toEqual([]);
    });

    it('silently skips when stat fails (file vanished)', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('gone.txt', '/dir', true),
      ]);
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      mockStat.mockRejectedValue(err);

      await syncState.takeLocalSnapshot(['/dir']);
      expect(syncState.snapshotKeys).toEqual([]);
    });

    it('skips directory entries (only processes files)', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('subdir', '/workspace/group', false),  // directory
        makeDirent('file.txt', '/workspace/group', true), // file
      ]);
      mockStat.mockResolvedValue(makeStats(100, 10));

      await syncState.takeLocalSnapshot(['/workspace/group']);

      expect(syncState.getSnapshotEntry('/workspace/group/subdir')).toBeUndefined();
      expect(syncState.getSnapshotEntry('/workspace/group/file.txt')).toEqual({ mtimeMs: 100, size: 10 });
    });
  });

  // ── snapshotKeys ───────────────────────────────────────────────

  describe('snapshotKeys', () => {
    it('returns all keys in the snapshot', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('a.txt', '/d', true),
        makeDirent('b.txt', '/d', true),
      ]);
      mockStat.mockResolvedValue(makeStats(1, 1));

      await syncState.takeLocalSnapshot(['/d']);

      const keys = syncState.snapshotKeys;
      expect(keys).toContain('/d/a.txt');
      expect(keys).toContain('/d/b.txt');
      expect(keys).toHaveLength(2);
    });
  });

  // ── reset ──────────────────────────────────────────────────────

  describe('reset', () => {
    it('clears all state', async () => {
      syncState.initialized = true;
      syncState.recordEtag('key', '"val"');
      syncState.recordDownloadedKey('p/', 'p/k');

      mockReaddir.mockResolvedValue([
        makeDirent('f.txt', '/d', true),
      ]);
      mockStat.mockResolvedValue(makeStats(1, 1));
      await syncState.takeLocalSnapshot(['/d']);

      syncState.reset();

      expect(syncState.initialized).toBe(false);
      expect(syncState.getEtag('key')).toBeUndefined();
      expect(syncState.getDownloadedKeys('p/')).toEqual([]);
      expect(syncState.snapshotKeys).toEqual([]);
    });
  });
});
