import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs and fs/promises before importing the module under test
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from('content')),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn(),
  realpath: vi.fn(),
}));

import { syncFromS3, syncToS3 } from '../session.js';
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

      if (cmdName === 'PutObjectCommand') {
        const key = (cmd.input as { Key?: string })?.Key ?? '';
        const resp = responses.get(`put:${key}`);
        return resp ?? { ETag: `"put-etag-${key}"` };
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

describe('session sync with SyncState', () => {
  let state: SyncState;

  beforeEach(() => {
    state = new SyncState();
    vi.clearAllMocks();
  });

  describe('syncFromS3 records ETags', () => {
    it('records ETags from downloadDirectory (ListObjectsV2) and downloadFile (GetObject)', async () => {
      const responses = new Map<string, unknown>();

      // Session directory listing with two files
      responses.set('list:user-1/bot-1/sessions/', {
        Contents: [
          { Key: 'user-1/bot-1/sessions/state.jsonl', ETag: '"sess-etag-1"' },
          { Key: 'user-1/bot-1/sessions/config.json', ETag: '"sess-etag-2"' },
        ],
        IsTruncated: false,
      });

      // GetObject responses for files found in listing
      responses.set('get:user-1/bot-1/sessions/state.jsonl', makeGetResponse('"sess-etag-1"'));
      responses.set('get:user-1/bot-1/sessions/config.json', makeGetResponse('"sess-etag-2"'));

      // Bot CLAUDE.md (direct file download)
      responses.set('get:user-1/bot-1/CLAUDE.md', makeGetResponse('"bot-claude-etag"'));

      // Group workspace listing
      responses.set('list:user-1/bot-1/workspace/tg:123/', {
        Contents: [
          { Key: 'user-1/bot-1/workspace/tg:123/CLAUDE.md', ETag: '"group-etag-1"' },
        ],
        IsTruncated: false,
      });

      // GetObject for group file
      responses.set('get:user-1/bot-1/workspace/tg:123/CLAUDE.md', makeGetResponse('"group-etag-1"'));

      const s3 = createMockS3Client(responses);

      await syncFromS3(
        s3 as never,
        'test-bucket',
        {
          sessionPath: 'user-1/bot-1/sessions/',
          botClaude: 'user-1/bot-1/CLAUDE.md',
          groupPrefix: 'user-1/bot-1/workspace/tg:123/',
        },
        mockLogger,
        state,
      );

      // ETags from directory listings (ListObjectsV2 provides ETags)
      expect(state.getEtag('user-1/bot-1/sessions/state.jsonl')).toBe('"sess-etag-1"');
      expect(state.getEtag('user-1/bot-1/sessions/config.json')).toBe('"sess-etag-2"');
      expect(state.getEtag('user-1/bot-1/workspace/tg:123/CLAUDE.md')).toBe('"group-etag-1"');

      // ETag from direct file download (bot CLAUDE.md)
      expect(state.getEtag('user-1/bot-1/CLAUDE.md')).toBe('"bot-claude-etag"');
    });

    it('records ETags from learnings directory when present', async () => {
      const responses = new Map<string, unknown>();

      // Minimal responses for required paths
      responses.set('list:user-1/bot-1/sessions/', { Contents: [], IsTruncated: false });
      responses.set('list:user-1/bot-1/workspace/tg:123/', { Contents: [], IsTruncated: false });

      // Learnings listing
      responses.set('list:user-1/bot-1/learnings/', {
        Contents: [
          { Key: 'user-1/bot-1/learnings/journal.md', ETag: '"learn-etag"' },
        ],
        IsTruncated: false,
      });
      responses.set('get:user-1/bot-1/learnings/journal.md', makeGetResponse('"learn-etag"'));

      const s3 = createMockS3Client(responses);

      await syncFromS3(
        s3 as never,
        'test-bucket',
        {
          sessionPath: 'user-1/bot-1/sessions/',
          botClaude: 'user-1/bot-1/CLAUDE.md',
          groupPrefix: 'user-1/bot-1/workspace/tg:123/',
          learningsPrefix: 'user-1/bot-1/learnings/',
        },
        mockLogger,
        state,
      );

      expect(state.getEtag('user-1/bot-1/learnings/journal.md')).toBe('"learn-etag"');
    });
  });

  describe('syncFromS3 records downloadedKeys', () => {
    it('records downloaded keys per prefix from directory listings', async () => {
      const responses = new Map<string, unknown>();

      responses.set('list:user-1/bot-1/sessions/', {
        Contents: [
          { Key: 'user-1/bot-1/sessions/state.jsonl', ETag: '"e1"' },
          { Key: 'user-1/bot-1/sessions/config.json', ETag: '"e2"' },
        ],
        IsTruncated: false,
      });
      responses.set('get:user-1/bot-1/sessions/state.jsonl', makeGetResponse('"e1"'));
      responses.set('get:user-1/bot-1/sessions/config.json', makeGetResponse('"e2"'));

      responses.set('list:user-1/bot-1/workspace/tg:123/', {
        Contents: [
          { Key: 'user-1/bot-1/workspace/tg:123/notes.txt', ETag: '"e3"' },
        ],
        IsTruncated: false,
      });
      responses.set('get:user-1/bot-1/workspace/tg:123/notes.txt', makeGetResponse('"e3"'));

      const s3 = createMockS3Client(responses);

      await syncFromS3(
        s3 as never,
        'test-bucket',
        {
          sessionPath: 'user-1/bot-1/sessions/',
          botClaude: 'user-1/bot-1/CLAUDE.md',
          groupPrefix: 'user-1/bot-1/workspace/tg:123/',
        },
        mockLogger,
        state,
      );

      const sessionKeys = state.getDownloadedKeys('user-1/bot-1/sessions/');
      expect(sessionKeys).toContain('user-1/bot-1/sessions/state.jsonl');
      expect(sessionKeys).toContain('user-1/bot-1/sessions/config.json');
      expect(sessionKeys).toHaveLength(2);

      const groupKeys = state.getDownloadedKeys('user-1/bot-1/workspace/tg:123/');
      expect(groupKeys).toContain('user-1/bot-1/workspace/tg:123/notes.txt');
      expect(groupKeys).toHaveLength(1);
    });

    it('does not record downloadedKeys for direct file downloads (bot CLAUDE.md)', async () => {
      const responses = new Map<string, unknown>();

      responses.set('list:sessions/', { Contents: [], IsTruncated: false });
      responses.set('list:workspace/', { Contents: [], IsTruncated: false });
      responses.set('get:bot/CLAUDE.md', makeGetResponse('"etag"'));

      const s3 = createMockS3Client(responses);

      await syncFromS3(
        s3 as never,
        'test-bucket',
        {
          sessionPath: 'sessions/',
          botClaude: 'bot/CLAUDE.md',
          groupPrefix: 'workspace/',
        },
        mockLogger,
        state,
      );

      // Direct file downloads do not record downloadedKeys (only directory listings do)
      expect(state.getDownloadedKeys('bot/')).toEqual([]);
    });
  });

  describe('syncFromS3 skips non-current session JSONLs', () => {
    it('keeps only the most-recent .jsonl per projects/<hash>/ directory', async () => {
      const responses = new Map<string, unknown>();

      // Session listing: 3 JSONLs for the same project (same cwd hash),
      // plus sessions-index.json that should always be downloaded.
      // (settings.json is intentionally filtered by isExcludedPath and never synced.)
      responses.set('list:user-1/bot-1/sessions/', {
        Contents: [
          { Key: 'user-1/bot-1/sessions/projects/-workspace-group/sessions-index.json', ETag: '"idx"', LastModified: new Date('2026-04-20T00:00:00Z') },
          { Key: 'user-1/bot-1/sessions/projects/-workspace-group/old-session.jsonl', ETag: '"old"', LastModified: new Date('2026-04-18T00:00:00Z') },
          { Key: 'user-1/bot-1/sessions/projects/-workspace-group/mid-session.jsonl', ETag: '"mid"', LastModified: new Date('2026-04-19T12:00:00Z') },
          { Key: 'user-1/bot-1/sessions/projects/-workspace-group/new-session.jsonl', ETag: '"new"', LastModified: new Date('2026-04-20T08:00:00Z') },
        ],
        IsTruncated: false,
      });
      responses.set('get:user-1/bot-1/sessions/projects/-workspace-group/sessions-index.json', makeGetResponse('"idx"'));
      responses.set('get:user-1/bot-1/sessions/projects/-workspace-group/new-session.jsonl', makeGetResponse('"new"'));

      responses.set('list:user-1/bot-1/workspace/tg:123/', { Contents: [], IsTruncated: false });

      const s3 = createMockS3Client(responses);

      await syncFromS3(
        s3 as never,
        'test-bucket',
        {
          sessionPath: 'user-1/bot-1/sessions/',
          botClaude: 'user-1/bot-1/CLAUDE.md',
          groupPrefix: 'user-1/bot-1/workspace/tg:123/',
        },
        mockLogger,
        state,
      );

      // Only the newest JSONL should be downloaded
      const getCalls = (s3.send as ReturnType<typeof vi.fn>).mock.calls
        .map(([cmd]) => cmd)
        .filter((cmd: { constructor: { name: string } }) => cmd.constructor.name === 'GetObjectCommand')
        .map((cmd: { input: { Key: string } }) => cmd.input.Key);

      expect(getCalls).toContain('user-1/bot-1/sessions/projects/-workspace-group/sessions-index.json');
      expect(getCalls).toContain('user-1/bot-1/sessions/projects/-workspace-group/new-session.jsonl');
      expect(getCalls).not.toContain('user-1/bot-1/sessions/projects/-workspace-group/old-session.jsonl');
      expect(getCalls).not.toContain('user-1/bot-1/sessions/projects/-workspace-group/mid-session.jsonl');

      // Downloaded keys should exclude the stale JSONLs
      const sessionKeys = state.getDownloadedKeys('user-1/bot-1/sessions/');
      expect(sessionKeys).not.toContain('user-1/bot-1/sessions/projects/-workspace-group/old-session.jsonl');
      expect(sessionKeys).not.toContain('user-1/bot-1/sessions/projects/-workspace-group/mid-session.jsonl');
      expect(sessionKeys).toContain('user-1/bot-1/sessions/projects/-workspace-group/new-session.jsonl');
    });

    it('keeps the latest JSONL independently for each projects/<hash>/', async () => {
      const responses = new Map<string, unknown>();

      responses.set('list:user-1/bot-1/sessions/', {
        Contents: [
          { Key: 'user-1/bot-1/sessions/projects/hashA/a-old.jsonl', ETag: '"a-old"', LastModified: new Date('2026-04-18T00:00:00Z') },
          { Key: 'user-1/bot-1/sessions/projects/hashA/a-new.jsonl', ETag: '"a-new"', LastModified: new Date('2026-04-19T00:00:00Z') },
          { Key: 'user-1/bot-1/sessions/projects/hashB/b-old.jsonl', ETag: '"b-old"', LastModified: new Date('2026-04-15T00:00:00Z') },
          { Key: 'user-1/bot-1/sessions/projects/hashB/b-new.jsonl', ETag: '"b-new"', LastModified: new Date('2026-04-20T00:00:00Z') },
        ],
        IsTruncated: false,
      });
      responses.set('get:user-1/bot-1/sessions/projects/hashA/a-new.jsonl', makeGetResponse('"a-new"'));
      responses.set('get:user-1/bot-1/sessions/projects/hashB/b-new.jsonl', makeGetResponse('"b-new"'));
      responses.set('list:user-1/bot-1/workspace/tg:123/', { Contents: [], IsTruncated: false });

      const s3 = createMockS3Client(responses);

      await syncFromS3(
        s3 as never,
        'test-bucket',
        {
          sessionPath: 'user-1/bot-1/sessions/',
          botClaude: 'user-1/bot-1/CLAUDE.md',
          groupPrefix: 'user-1/bot-1/workspace/tg:123/',
        },
        mockLogger,
        state,
      );

      const getCalls = (s3.send as ReturnType<typeof vi.fn>).mock.calls
        .map(([cmd]) => cmd)
        .filter((cmd: { constructor: { name: string } }) => cmd.constructor.name === 'GetObjectCommand')
        .map((cmd: { input: { Key: string } }) => cmd.input.Key);

      expect(getCalls).toContain('user-1/bot-1/sessions/projects/hashA/a-new.jsonl');
      expect(getCalls).toContain('user-1/bot-1/sessions/projects/hashB/b-new.jsonl');
      expect(getCalls).not.toContain('user-1/bot-1/sessions/projects/hashA/a-old.jsonl');
      expect(getCalls).not.toContain('user-1/bot-1/sessions/projects/hashB/b-old.jsonl');
    });
  });

  describe('syncFromS3 without state (backward compat)', () => {
    it('works without state parameter', async () => {
      const responses = new Map<string, unknown>();
      responses.set('list:sessions/', { Contents: [], IsTruncated: false });
      responses.set('list:workspace/', { Contents: [], IsTruncated: false });

      const s3 = createMockS3Client(responses);

      // Should not throw when state is omitted
      await syncFromS3(
        s3 as never,
        'test-bucket',
        {
          sessionPath: 'sessions/',
          botClaude: 'bot/CLAUDE.md',
          groupPrefix: 'workspace/',
        },
        mockLogger,
      );
    });
  });

  describe('syncToS3 records ETags', () => {
    it('records ETags from uploaded files', async () => {
      const { readdir, readFile, realpath } = await import('fs/promises');
      const mockReaddir = readdir as unknown as ReturnType<typeof vi.fn>;
      const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>;
      const mockRealpath = realpath as unknown as ReturnType<typeof vi.fn>;

      // uploadDirectory needs readdir to return entries, readFile for content
      mockReaddir.mockResolvedValue([]);
      mockReadFile.mockResolvedValue(Buffer.from('bot claude content'));
      mockRealpath.mockImplementation(async (p: string) => p);

      const responses = new Map<string, unknown>();
      responses.set('put:bot/CLAUDE.md', { ETag: '"upload-etag"' });

      const s3 = createMockS3Client(responses);

      await syncToS3(
        s3 as never,
        'test-bucket',
        {
          sessionPath: 'sessions/',
          botClaude: 'bot/CLAUDE.md',
          groupPrefix: 'workspace/',
        },
        mockLogger,
        state,
      );

      // Bot CLAUDE.md upload should record its ETag
      expect(state.getEtag('bot/CLAUDE.md')).toBe('"upload-etag"');
    });
  });

  describe('syncToS3 without state (backward compat)', () => {
    it('works without state parameter', async () => {
      const { readdir, readFile, realpath } = await import('fs/promises');
      const mockReaddir = readdir as unknown as ReturnType<typeof vi.fn>;
      const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>;
      const mockRealpath = realpath as unknown as ReturnType<typeof vi.fn>;

      mockReaddir.mockResolvedValue([]);
      mockReadFile.mockResolvedValue(Buffer.from('content'));
      mockRealpath.mockImplementation(async (p: string) => p);

      const responses = new Map<string, unknown>();
      const s3 = createMockS3Client(responses);

      // Should not throw when state is omitted
      await syncToS3(
        s3 as never,
        'test-bucket',
        {
          sessionPath: 'sessions/',
          botClaude: 'bot/CLAUDE.md',
          groupPrefix: 'workspace/',
        },
        mockLogger,
      );
    });
  });
});
