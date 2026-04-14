/**
 * Shared exclusion rules for S3 sync and local file scanning.
 * Used by both session.ts and sync-state.ts to ensure consistent behavior.
 */

/** Directory names that should never be synced to/from S3. */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__']);

/** File names that should never be synced to/from S3 (managed at runtime, not persisted). */
const EXCLUDED_FILES = new Set(['settings.json']);

/**
 * Check if a relative path contains an excluded directory segment or excluded file.
 * e.g. "foo/.git/objects/pack.idx" → true, "settings.json" → true, "foo/bar.txt" → false
 */
export function isExcludedPath(relPath: string): boolean {
  const segments = relPath.split('/');
  if (EXCLUDED_FILES.has(segments[segments.length - 1])) return true;
  return segments.some((seg) => EXCLUDED_DIRS.has(seg));
}
