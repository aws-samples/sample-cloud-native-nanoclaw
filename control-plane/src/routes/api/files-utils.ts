// ClawBot Cloud — File routes shared helpers
import { posix } from 'node:path';

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Validate and normalize a user-supplied relative S3 key.
 * Rejects empty, leading-slash, and any key containing .. segments
 * (path-traversal attempt). Reject happens pre-normalize because
 * posix.normalize collapses "a/../b" to "b" which would silently pass.
 */
export function validateRelativeKey(key: string): string {
  if (!key || typeof key !== 'string') throw new Error('invalid key');
  if (key.startsWith('/')) throw new Error('invalid key');
  if (key.split('/').includes('..')) throw new Error('invalid key');
  return posix.normalize(key);
}
