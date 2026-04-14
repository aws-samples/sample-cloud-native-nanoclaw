/**
 * ClawBot Cloud — SyncState
 *
 * Pure in-memory state tracker for incremental S3 sync.
 * Tracks S3 ETags, downloaded key sets, and local file snapshots
 * to enable diff-based upload/download across invocations.
 */

import { readdir, stat } from 'fs/promises';
import { join, relative } from 'path';

/** Directory names that should never be scanned or synced. */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__']);

/** File names that should never be scanned or synced. */
const EXCLUDED_FILES = new Set(['settings.json']);

/**
 * Check if a relative path contains an excluded directory segment or excluded file.
 */
function isExcludedPath(relPath: string): boolean {
  const segments = relPath.split('/');
  if (EXCLUDED_FILES.has(segments[segments.length - 1])) return true;
  return segments.some((seg) => EXCLUDED_DIRS.has(seg));
}

export class SyncState {
  initialized = false;

  /** S3 ETags: s3Key -> ETag string */
  private _s3Etags = new Map<string, string>();

  /** Downloaded keys: prefix -> Set<s3Key> */
  private _downloadedKeys = new Map<string, Set<string>>();

  /** Local file stat snapshot: fullPath -> {mtimeMs, size} */
  private _localSnapshot = new Map<string, { mtimeMs: number; size: number }>();

  // ── ETag tracking ────────────────────────────────────────────

  recordEtag(s3Key: string, etag: string): void {
    this._s3Etags.set(s3Key, etag);
  }

  getEtag(s3Key: string): string | undefined {
    return this._s3Etags.get(s3Key);
  }

  deleteEtag(s3Key: string): void {
    this._s3Etags.delete(s3Key);
  }

  /** Remove all ETags whose key starts with the given prefix. */
  clearPrefix(prefix: string): void {
    for (const key of this._s3Etags.keys()) {
      if (key.startsWith(prefix)) {
        this._s3Etags.delete(key);
      }
    }
  }

  // ── Downloaded keys tracking ─────────────────────────────────

  recordDownloadedKey(prefix: string, s3Key: string): void {
    let set = this._downloadedKeys.get(prefix);
    if (!set) {
      set = new Set();
      this._downloadedKeys.set(prefix, set);
    }
    set.add(s3Key);
  }

  getDownloadedKeys(prefix: string): string[] {
    const set = this._downloadedKeys.get(prefix);
    return set ? [...set] : [];
  }

  clearDownloadedKeys(prefix: string): void {
    this._downloadedKeys.delete(prefix);
  }

  // ── Local file snapshot ──────────────────────────────────────

  /**
   * Scan directories and record mtime + size for every non-excluded file.
   * Clears any previous snapshot before scanning.
   */
  async takeLocalSnapshot(dirs: string[]): Promise<void> {
    this._localSnapshot.clear();

    for (const dir of dirs) {
      try {
        const entries = await readdir(dir, { recursive: true, withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isFile()) continue;

          const fullPath = join(entry.parentPath ?? '', entry.name);
          const rel = relative(dir, fullPath);

          if (isExcludedPath(rel)) continue;

          try {
            const st = await stat(fullPath);
            this._localSnapshot.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size });
          } catch {
            // File may have vanished between readdir and stat — skip silently
          }
        }
      } catch {
        // Directory may not exist — skip silently
      }
    }
  }

  getSnapshotEntry(fullPath: string): { mtimeMs: number; size: number } | undefined {
    return this._localSnapshot.get(fullPath);
  }

  get snapshotKeys(): string[] {
    return [...this._localSnapshot.keys()];
  }

  // ── Reset ────────────────────────────────────────────────────

  reset(): void {
    this.initialized = false;
    this._s3Etags.clear();
    this._downloadedKeys.clear();
    this._localSnapshot.clear();
  }
}

export const syncState = new SyncState();
