import { describe, it, expect } from 'vitest';
import { validateRelativeKey, MAX_UPLOAD_BYTES } from '../routes/api/files-utils.js';

describe('validateRelativeKey', () => {
  it('accepts a normal relative key', () => {
    expect(validateRelativeKey('shared/a.txt')).toBe('shared/a.txt');
  });

  it('accepts a single file at root', () => {
    expect(validateRelativeKey('CLAUDE.md')).toBe('CLAUDE.md');
  });

  it('normalizes redundant slashes', () => {
    expect(validateRelativeKey('a//b/./c.txt')).toBe('a/b/c.txt');
  });

  it('rejects empty key', () => {
    expect(() => validateRelativeKey('')).toThrow(/invalid key/);
  });

  it('rejects leading slash', () => {
    expect(() => validateRelativeKey('/abs/path')).toThrow(/invalid key/);
  });

  it('rejects .. segments', () => {
    expect(() => validateRelativeKey('../etc/passwd')).toThrow(/invalid key/);
  });

  it('rejects .. segments in the middle', () => {
    expect(() => validateRelativeKey('a/../b')).toThrow(/invalid key/);
  });

  it('rejects pure ..', () => {
    expect(() => validateRelativeKey('..')).toThrow(/invalid key/);
  });
});

describe('MAX_UPLOAD_BYTES', () => {
  it('is 100 MB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
  });
});
