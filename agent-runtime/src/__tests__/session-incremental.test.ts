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

import { incrementalSyncFromS3 } from '../session.js';
import { SyncState } from '../sync-state.js';
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

function createMockS3Client(responses: Map<string, unknown>) {
  return {
    send: vi.fn(async (cmd: { constructor: { name: string }; input?: Record<string, unknown> }) => {
      const cmdName = cmd.constructor.name;

      if (cmdName === 'HeadObjectCommand') {
        const key = (cmd.input as { Key?: string })?.Key ?? '';
        const resp = responses.get(`head:${key}`);
        if (!resp) {
          const err = new Error('NotFound');
          err.name = 'NotFound';
          throw err;
        }
        return resp;
      }

      if (cmdName === 'ListObjectsV2Command') {
        const prefix = (cmd.input as { Prefix?: string })?.Prefix ?? '';
        const resp = responses.get(`list:${prefix}`);
        return resp ?? { Contents: [], IsTruncated: false };
      }

      if (cmdName === 'GetObjectCommand') {
        const key = (cmd.input as { Key?: string })?.Key ?? '';
        const resp = responses.get(`get:${key}`);
        if (!resp) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        return resp;
      }

      return {};
    }),
  };
}

function makeGetResponse(etag: string) {
  return {
    Body: {
      transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    },
    ETag: etag,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('incrementalSyncFromS3', () => {
  let state: SyncState;

  beforeEach(() => {
    state = new SyncState();
    state.initialized = true;
    vi.clearAllMocks();
  });

  const basePaths = {
    sessionPath: 'user-1/bot-1/sessions/',
    botClaude: 'user-1/bot-1/CLAUDE.md',
    groupPrefix: 'user-1/bot-1/workspace/tg:123/',
  };

  // ── Test 1: skips session download entirely ─────────────────────────

  it('skips session state download entirely (no ListObjectsV2 or GetObject for sessionPath)', async () => {
    const responses = new Map<string, unknown>();

    // botClaude HeadObject — return NotFound (no download needed)
    // (no entry for head:... means NotFound is thrown)

    // Group workspace — empty
    responses.set('list:user-1/bot-1/workspace/tg:123/', {
      Contents: [],
      IsTruncated: false,
    });

    const s3 = createMockS3Client(responses);

    await incrementalSyncFromS3(s3 as never, 'test-bucket', basePaths, mockLogger, state);

    // Verify no S3 calls were made for the sessionPath prefix
    const allCalls = s3.send.mock.calls;
    for (const [cmd] of allCalls) {
      const cmdName = cmd.constructor.name;
      const input = cmd.input as Record<string, unknown>;

      if (cmdName === 'ListObjectsV2Command') {
        expect(input.Prefix).not.toBe('user-1/bot-1/sessions/');
      }
      if (cmdName === 'GetObjectCommand') {
        expect((input.Key as string) ?? '').not.toMatch(/^user-1\/bot-1\/sessions\//);
      }
    }
  });

  // ── Test 2: skips botClaude when ETag unchanged ─────────────────────

  it('skips botClaude download when ETag is unchanged', async () => {
    // Pre-populate state with existing ETag
    state.recordEtag('user-1/bot-1/CLAUDE.md', '"existing-etag"');

    const responses = new Map<string, unknown>();

    // HeadObject returns the same ETag
    responses.set('head:user-1/bot-1/CLAUDE.md', { ETag: '"existing-etag"' });

    // Group workspace — empty
    responses.set('list:user-1/bot-1/workspace/tg:123/', {
      Contents: [],
      IsTruncated: false,
    });

    const s3 = createMockS3Client(responses);

    await incrementalSyncFromS3(s3 as never, 'test-bucket', basePaths, mockLogger, state);

    // Verify HeadObject was called for botClaude
    const headCalls = s3.send.mock.calls.filter(
      ([cmd]: [{ constructor: { name: string }; input?: Record<string, unknown> }]) =>
        cmd.constructor.name === 'HeadObjectCommand',
    );
    expect(headCalls).toHaveLength(1);

    // Verify NO GetObject was called for botClaude (ETag matched, skip download)
    const getCalls = s3.send.mock.calls.filter(
      ([cmd]: [{ constructor: { name: string }; input?: Record<string, unknown> }]) =>
        cmd.constructor.name === 'GetObjectCommand' &&
        (cmd.input as Record<string, unknown>)?.Key === 'user-1/bot-1/CLAUDE.md',
    );
    expect(getCalls).toHaveLength(0);
  });

  // ── Test 3: re-downloads botClaude when ETag changes ────────────────

  it('re-downloads botClaude when ETag changes', async () => {
    // Pre-populate state with old ETag
    state.recordEtag('user-1/bot-1/CLAUDE.md', '"old-etag"');

    const responses = new Map<string, unknown>();

    // HeadObject returns a different ETag
    responses.set('head:user-1/bot-1/CLAUDE.md', { ETag: '"new-etag"' });

    // GetObject for the re-download
    responses.set('get:user-1/bot-1/CLAUDE.md', makeGetResponse('"new-etag"'));

    // Group workspace — empty
    responses.set('list:user-1/bot-1/workspace/tg:123/', {
      Contents: [],
      IsTruncated: false,
    });

    const s3 = createMockS3Client(responses);

    await incrementalSyncFromS3(s3 as never, 'test-bucket', basePaths, mockLogger, state);

    // Verify GetObject WAS called for botClaude (ETag changed, must re-download)
    const getCalls = s3.send.mock.calls.filter(
      ([cmd]: [{ constructor: { name: string }; input?: Record<string, unknown> }]) =>
        cmd.constructor.name === 'GetObjectCommand' &&
        (cmd.input as Record<string, unknown>)?.Key === 'user-1/bot-1/CLAUDE.md',
    );
    expect(getCalls).toHaveLength(1);

    // State should have the new ETag
    expect(state.getEtag('user-1/bot-1/CLAUDE.md')).toBe('"new-etag"');
  });

  // ── Test 4: downloads new file in group workspace ───────────────────

  it('downloads new file in group workspace not previously in state', async () => {
    const responses = new Map<string, unknown>();

    // Group workspace has a new file
    responses.set('list:user-1/bot-1/workspace/tg:123/', {
      Contents: [
        { Key: 'user-1/bot-1/workspace/tg:123/notes.md', ETag: '"notes-etag"' },
      ],
      IsTruncated: false,
    });

    // GetObject for the new file
    responses.set('get:user-1/bot-1/workspace/tg:123/notes.md', makeGetResponse('"notes-etag"'));

    const s3 = createMockS3Client(responses);

    await incrementalSyncFromS3(s3 as never, 'test-bucket', basePaths, mockLogger, state);

    // GetObject should have been called for the new file
    const getCalls = s3.send.mock.calls.filter(
      ([cmd]: [{ constructor: { name: string }; input?: Record<string, unknown> }]) =>
        cmd.constructor.name === 'GetObjectCommand' &&
        (cmd.input as Record<string, unknown>)?.Key === 'user-1/bot-1/workspace/tg:123/notes.md',
    );
    expect(getCalls).toHaveLength(1);

    // ETag should be recorded
    expect(state.getEtag('user-1/bot-1/workspace/tg:123/notes.md')).toBe('"notes-etag"');

    // Downloaded key should be recorded
    const keys = state.getDownloadedKeys('user-1/bot-1/workspace/tg:123/');
    expect(keys).toContain('user-1/bot-1/workspace/tg:123/notes.md');
  });

  // ── Test 5: skips unchanged file in group workspace ─────────────────

  it('skips unchanged file in group workspace when ETag matches', async () => {
    // Pre-populate: file was previously downloaded
    state.recordEtag('user-1/bot-1/workspace/tg:123/notes.md', '"same-etag"');
    state.recordDownloadedKey('user-1/bot-1/workspace/tg:123/', 'user-1/bot-1/workspace/tg:123/notes.md');

    const responses = new Map<string, unknown>();

    // Group workspace listing returns the same file with same ETag
    responses.set('list:user-1/bot-1/workspace/tg:123/', {
      Contents: [
        { Key: 'user-1/bot-1/workspace/tg:123/notes.md', ETag: '"same-etag"' },
      ],
      IsTruncated: false,
    });

    const s3 = createMockS3Client(responses);

    await incrementalSyncFromS3(s3 as never, 'test-bucket', basePaths, mockLogger, state);

    // NO GetObject should be called — ETag matched
    const getCalls = s3.send.mock.calls.filter(
      ([cmd]: [{ constructor: { name: string }; input?: Record<string, unknown> }]) =>
        cmd.constructor.name === 'GetObjectCommand',
    );
    expect(getCalls).toHaveLength(0);
  });

  // ── Test 6: deletes local file when S3 key disappears ───────────────

  it('deletes local file when S3 key disappears (removed via web console)', async () => {
    const { unlink } = await import('fs/promises');
    const mockUnlink = unlink as unknown as ReturnType<typeof vi.fn>;

    // Pre-populate: a file was previously downloaded
    state.recordDownloadedKey(
      'user-1/bot-1/workspace/tg:123/',
      'user-1/bot-1/workspace/tg:123/old-file.md',
    );
    state.recordEtag('user-1/bot-1/workspace/tg:123/old-file.md', '"old-etag"');

    const responses = new Map<string, unknown>();

    // Group workspace listing returns EMPTY — old-file.md was deleted in S3
    responses.set('list:user-1/bot-1/workspace/tg:123/', {
      Contents: [],
      IsTruncated: false,
    });

    const s3 = createMockS3Client(responses);

    await incrementalSyncFromS3(s3 as never, 'test-bucket', basePaths, mockLogger, state);

    // unlink should have been called for the local file corresponding to the vanished S3 key
    expect(mockUnlink).toHaveBeenCalledWith('/workspace/group/old-file.md');

    // Stale ETag should be cleared
    expect(state.getEtag('user-1/bot-1/workspace/tg:123/old-file.md')).toBeUndefined();
  });

  // ── Test 7: handles learnings prefix ────────────────────────────────

  it('incrementally syncs learnings directory when present', async () => {
    const pathsWithLearnings = {
      ...basePaths,
      learningsPrefix: 'user-1/bot-1/learnings/',
    };

    // Pre-populate: one file in learnings was previously downloaded
    state.recordDownloadedKey('user-1/bot-1/learnings/', 'user-1/bot-1/learnings/old.md');
    state.recordEtag('user-1/bot-1/learnings/old.md', '"old-learn-etag"');

    const responses = new Map<string, unknown>();

    // Group workspace — empty
    responses.set('list:user-1/bot-1/workspace/tg:123/', {
      Contents: [],
      IsTruncated: false,
    });

    // Learnings has a new file and the old one is gone
    responses.set('list:user-1/bot-1/learnings/', {
      Contents: [
        { Key: 'user-1/bot-1/learnings/new.md', ETag: '"new-learn-etag"' },
      ],
      IsTruncated: false,
    });

    responses.set('get:user-1/bot-1/learnings/new.md', makeGetResponse('"new-learn-etag"'));

    const s3 = createMockS3Client(responses);

    const { unlink } = await import('fs/promises');
    const mockUnlink = unlink as unknown as ReturnType<typeof vi.fn>;

    await incrementalSyncFromS3(s3 as never, 'test-bucket', pathsWithLearnings, mockLogger, state);

    // New file should be downloaded
    const getCalls = s3.send.mock.calls.filter(
      ([cmd]: [{ constructor: { name: string }; input?: Record<string, unknown> }]) =>
        cmd.constructor.name === 'GetObjectCommand' &&
        (cmd.input as Record<string, unknown>)?.Key === 'user-1/bot-1/learnings/new.md',
    );
    expect(getCalls).toHaveLength(1);

    // Old file should be deleted locally
    expect(mockUnlink).toHaveBeenCalledWith('/workspace/learnings/old.md');

    // ETags should reflect current state
    expect(state.getEtag('user-1/bot-1/learnings/new.md')).toBe('"new-learn-etag"');
    expect(state.getEtag('user-1/bot-1/learnings/old.md')).toBeUndefined();
  });
});
