import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { truncateContent, DEFAULT_TRUNCATION, type TruncationConfig } from '../memory.js';

// Mock fs/promises at module level for loadMemoryLayers tests
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

// ── truncateContent ─────────────────────────────────────────────────────────

describe('truncateContent', () => {
  const config: TruncationConfig = { ...DEFAULT_TRUNCATION };
  const MARKER = '\n\n[...truncated...]\n\n';

  it('returns content unchanged when under cap', () => {
    const text = 'short text';
    expect(truncateContent(text, 100, config)).toBe(text);
  });

  it('returns content unchanged when exactly at cap', () => {
    const text = 'a'.repeat(500);
    expect(truncateContent(text, 500, config)).toBe(text);
  });

  it('truncates content exceeding cap', () => {
    const text = 'a'.repeat(1000);
    const result = truncateContent(text, 100, config);
    expect(result).toContain('[...truncated...]');
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('preserves head and tail content', () => {
    const text = 'HEAD_CONTENT_' + 'x'.repeat(500) + '_TAIL_CONTENT';
    const result = truncateContent(text, 200, config);
    expect(result).toContain('HEAD_CONTENT_');
    expect(result).toContain('_TAIL_CONTENT');
    expect(result).toContain(MARKER);
  });

  it('output never exceeds maxChars for various budgets', () => {
    const text = 'x'.repeat(50000);
    for (const cap of [50, 100, 500, 1000, 10000, 20000]) {
      const result = truncateContent(text, cap, config);
      expect(result.length).toBeLessThanOrEqual(cap);
    }
  });

  it('handles very small budget with hard-slice', () => {
    const text = 'hello world this is a test';
    const result = truncateContent(text, 5, config);
    expect(result).toBe('hello');
  });

  it('handles zero budget', () => {
    expect(truncateContent('hello', 0, config)).toBe('');
  });

  it('handles empty content', () => {
    expect(truncateContent('', 100, config)).toBe('');
  });

  it('handles budget equal to marker length', () => {
    const result = truncateContent('a'.repeat(100), MARKER.length, config);
    expect(result.length).toBeLessThanOrEqual(MARKER.length);
  });

  it('handles content one char over cap', () => {
    const text = 'a'.repeat(101);
    const result = truncateContent(text, 100, config);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain('[...truncated...]');
  });

  it('respects custom head/tail ratios', () => {
    const text = 'AAAA' + 'x'.repeat(500) + 'BBBB';
    const customConfig: TruncationConfig = { perFileCap: 20000, totalCap: 100000, headRatio: 0.5, tailRatio: 0.4 };
    const result = truncateContent(text, 200, customConfig);
    expect(result).toContain('AAAA');
    expect(result).toContain('BBBB');
  });
});

// ── loadMemoryLayers ────────────────────────────────────────────────────────

describe('loadMemoryLayers', () => {
  let mockReadFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const fsMod = await import('fs/promises');
    mockReadFile = fsMod.readFile as ReturnType<typeof vi.fn>;
    mockReadFile.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Dynamic import to get the version that uses the mocked fs
  async function getLoadMemoryLayers() {
    // Re-import to pick up the mock
    const mod = await import('../memory.js');
    return mod.loadMemoryLayers;
  }

  it('returns empty layers when no files exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const loadMemoryLayers = await getLoadMemoryLayers();
    const result = await loadMemoryLayers();
    expect(result.layers).toHaveLength(0);
    expect(result.totalChars).toBe(0);
  });

  it('loads all three memory layers', async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p.includes('shared')) return 'shared content';
      if (p.includes('global')) return 'global content';
      if (p.includes('group')) return 'group content';
      throw new Error('ENOENT');
    });

    const loadMemoryLayers = await getLoadMemoryLayers();
    const result = await loadMemoryLayers();
    expect(result.layers).toHaveLength(3);
    expect(result.layers[0].label).toBe('# Shared Memory');
    expect(result.layers[0].content).toBe('shared content');
    expect(result.layers[1].label).toBe('# Bot Memory');
    expect(result.layers[2].label).toBe('# Group Memory');
  });

  it('skips empty or whitespace-only files', async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p.includes('shared')) return '  \n  ';
      if (p.includes('global')) return 'real content';
      throw new Error('ENOENT');
    });

    const loadMemoryLayers = await getLoadMemoryLayers();
    const result = await loadMemoryLayers();
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].label).toBe('# Bot Memory');
  });

  it('applies per-file cap', async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      if (String(path).includes('shared')) return 'x'.repeat(30000);
      throw new Error('ENOENT');
    });

    const loadMemoryLayers = await getLoadMemoryLayers();
    const config: TruncationConfig = { perFileCap: 1000, totalCap: 100000, headRatio: 0.7, tailRatio: 0.2 };
    const result = await loadMemoryLayers(config);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].content.length).toBeLessThanOrEqual(1000);
    expect(result.layers[0].content).toContain('[...truncated...]');
  });

  it('enforces total cap across all layers', async () => {
    mockReadFile.mockResolvedValue('y'.repeat(50000));

    const loadMemoryLayers = await getLoadMemoryLayers();
    const config: TruncationConfig = { perFileCap: 50000, totalCap: 60000, headRatio: 0.7, tailRatio: 0.2 };
    const result = await loadMemoryLayers(config);
    expect(result.totalChars).toBeLessThanOrEqual(60000);
  });

  it('stops adding layers when total cap exhausted', async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p.includes('shared')) return 'a'.repeat(90000);
      if (p.includes('global')) return 'b'.repeat(90000);
      if (p.includes('group')) return 'c'.repeat(90000);
      throw new Error('ENOENT');
    });

    const loadMemoryLayers = await getLoadMemoryLayers();
    const config: TruncationConfig = { perFileCap: 100000, totalCap: 100000, headRatio: 0.7, tailRatio: 0.2 };
    const result = await loadMemoryLayers(config);
    // All layers get loaded but truncated to fit within total cap
    expect(result.totalChars).toBeLessThanOrEqual(100000);
    // At least the first layer should be full-sized, subsequent ones truncated
    expect(result.layers[0].content.length).toBe(90000);
  });
});
