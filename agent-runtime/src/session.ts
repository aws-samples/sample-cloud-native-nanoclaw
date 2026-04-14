/**
 * ClawBot Cloud — S3 Session Sync
 *
 * Replaces NanoClaw's Docker volume mounts with S3 round-trips:
 *   Before invocation → download session + memory files from S3
 *   After invocation  → upload changed files back to S3
 *
 * Layout:
 *   /home/node/.claude/           ← Claude Code session state + bot-level CLAUDE.md
 *   /workspace/group/             ← Group workspace (CLAUDE.md, conversations/, .claude/, agent files)
 *   /workspace/learnings/         ← Learning journal
 */

import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { SyncState } from './sync-state.js';

import { mkdir, readdir, readFile, writeFile, stat, realpath, unlink } from 'fs/promises';
import { join, dirname, relative } from 'path';
import type pino from 'pino';

const WORKSPACE_BASE = '/workspace';
const CLAUDE_DIR = '/home/node/.claude';

export interface SyncPaths {
  /** S3 prefix for Claude Code session files */
  sessionPath: string;
  /** S3 key for bot-level CLAUDE.md → /home/node/.claude/CLAUDE.md */
  botClaude: string;
  /** S3 prefix for group workspace → /workspace/group/ (full directory sync) */
  groupPrefix: string;
  /** S3 prefix for learnings → /workspace/learnings/ */
  learningsPrefix?: string;
}

/**
 * Download session + memory files from S3 to local workspace.
 * Called before agent invocation.
 */
export async function syncFromS3(
  s3: S3Client,
  bucket: string,
  paths: SyncPaths,
  logger: pino.Logger,
  state?: SyncState,
): Promise<void> {
  // 1. Download session directory → /home/node/.claude/
  await downloadDirectory(s3, bucket, paths.sessionPath, CLAUDE_DIR, logger, state);

  // 2. Download bot CLAUDE.md → /home/node/.claude/CLAUDE.md
  await downloadFile(s3, bucket, paths.botClaude, join(CLAUDE_DIR, 'CLAUDE.md'), logger, state);

  // 3. Download entire group workspace → /workspace/group/
  await downloadDirectory(s3, bucket, paths.groupPrefix, join(WORKSPACE_BASE, 'group'), logger, state);

  // 4. Download learnings → /workspace/learnings/
  if (paths.learningsPrefix) {
    await downloadDirectory(s3, bucket, paths.learningsPrefix, join(WORKSPACE_BASE, 'learnings'), logger, state);
  }
}

/**
 * Upload changed session + memory files back to S3.
 * Called after agent invocation completes.
 */
export async function syncToS3(
  s3: S3Client,
  bucket: string,
  paths: SyncPaths,
  logger: pino.Logger,
  state?: SyncState,
): Promise<void> {
  // 1. Upload session directory (Claude Code state)
  await uploadDirectory(s3, bucket, CLAUDE_DIR, paths.sessionPath, logger, undefined, state);

  // 2. Upload bot CLAUDE.md from /home/node/.claude/CLAUDE.md → S3
  await uploadFile(s3, bucket, join(CLAUDE_DIR, 'CLAUDE.md'), paths.botClaude, logger, state);

  // 3. Upload entire group workspace → S3
  await uploadDirectory(s3, bucket, join(WORKSPACE_BASE, 'group'), paths.groupPrefix, logger, undefined, state);

  // 4. Upload learnings directory
  if (paths.learningsPrefix) {
    await uploadDirectory(s3, bucket, join(WORKSPACE_BASE, 'learnings'), paths.learningsPrefix, logger, undefined, state);
  }
}

/**
 * Download enabled skills from S3 to ~/.claude/skills/.
 * Overlays onto existing directory — does NOT delete bundled or previously downloaded skills.
 * Payload contains S3 prefix names (e.g., "email-manager"), not skill IDs.
 */
export async function downloadSkills(
  s3: S3Client,
  bucket: string,
  skillPrefixes: string[],
  logger: pino.Logger,
): Promise<void> {
  const SKILLS_DIR = join(CLAUDE_DIR, 'skills');
  await mkdir(SKILLS_DIR, { recursive: true });

  for (const prefix of skillPrefixes) {
    const s3Prefix = `skills/${prefix}/`;
    logger.info({ prefix, s3Prefix }, 'Downloading skill from S3');
    await downloadDirectory(s3, bucket, s3Prefix, join(SKILLS_DIR, prefix), logger);
  }
}

/**
 * Delete all objects under the session S3 prefix.
 * Used when model/provider changes make existing session JSONL incompatible.
 */
export async function clearSessionDirectory(
  s3: S3Client,
  bucket: string,
  sessionPrefix: string,
  logger: pino.Logger,
): Promise<void> {
  let continuationToken: string | undefined;
  let deletedCount = 0;

  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: sessionPrefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const obj of resp.Contents ?? []) {
      if (!obj.Key) continue;
      await deleteS3Object(s3, bucket, obj.Key, logger);
      deletedCount++;
    }

    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  if (deletedCount > 0) {
    logger.info({ sessionPrefix, deletedCount }, 'Cleared old session files from S3');
  }
}

/**
 * Download memory files only (bot CLAUDE.md, group workspace, learnings) — no session state.
 * Used during session reset to preserve memory while discarding incompatible session JSONL.
 */
export async function syncMemoryOnlyFromS3(
  s3: S3Client,
  bucket: string,
  paths: SyncPaths,
  logger: pino.Logger,
  state?: SyncState,
): Promise<void> {
  // Skip step 1 (session directory) — that's the incompatible data

  // 2. Download bot CLAUDE.md
  await downloadFile(s3, bucket, paths.botClaude, join(CLAUDE_DIR, 'CLAUDE.md'), logger, state);

  // 3. Download group workspace
  await downloadDirectory(s3, bucket, paths.groupPrefix, join(WORKSPACE_BASE, 'group'), logger, state);

  // 4. Download learnings
  if (paths.learningsPrefix) {
    await downloadDirectory(s3, bucket, paths.learningsPrefix, join(WORKSPACE_BASE, 'learnings'), logger, state);
  }
}

/**
 * Incremental download: skip session state, re-download only changed memory files.
 *
 * Used when the same session continues on the same VM/task (Path B).
 * - Session state download is skipped entirely (local is authoritative).
 * - Bot CLAUDE.md is re-downloaded only if ETag changed (HeadObject check).
 * - Group workspace and learnings are incrementally synced: changed/new files
 *   are downloaded, and local files whose S3 keys disappeared are deleted.
 */
export async function incrementalSyncFromS3(
  s3: S3Client,
  bucket: string,
  paths: SyncPaths,
  logger: pino.Logger,
  state: SyncState,
): Promise<void> {
  // 1. Skip session state download entirely (local is authoritative)

  // 2. HeadObject check botClaude — re-download only if changed
  await downloadFileIfChanged(s3, bucket, paths.botClaude, join(CLAUDE_DIR, 'CLAUDE.md'), logger, state);

  // 3. Incremental download group workspace
  await downloadDirectoryIncremental(s3, bucket, paths.groupPrefix, join(WORKSPACE_BASE, 'group'), logger, state);

  // 4. Incremental download learnings (if present)
  if (paths.learningsPrefix) {
    await downloadDirectoryIncremental(s3, bucket, paths.learningsPrefix, join(WORKSPACE_BASE, 'learnings'), logger, state);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Directory names that should never be synced to/from S3. */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__']);

/** Files that should never be synced to/from S3 (managed at runtime, not persisted). */
const EXCLUDED_FILES = new Set(['settings.json']);

/**
 * Check if a relative path contains an excluded directory segment or excluded file.
 * e.g. "foo/.git/objects/pack.idx" → true, "settings.json" → true, "foo/bar.txt" → false
 */
function isExcludedPath(relPath: string): boolean {
  const segments = relPath.split('/');
  if (EXCLUDED_FILES.has(segments[segments.length - 1])) return true;
  return segments.some((seg) => EXCLUDED_DIRS.has(seg));
}

/**
 * HeadObject ETag check for a single file. Re-downloads only if ETag changed.
 */
async function downloadFileIfChanged(
  s3: S3Client,
  bucket: string,
  key: string,
  localPath: string,
  logger: pino.Logger,
  state: SyncState,
): Promise<void> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const remoteEtag = head.ETag;
    const cachedEtag = state.getEtag(key);

    if (remoteEtag && cachedEtag === remoteEtag) {
      logger.debug({ key, etag: remoteEtag }, 'ETag unchanged, skipping download');
      return;
    }

    // ETag different or new — full download
    await downloadFile(s3, bucket, key, localPath, logger, state);
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === 'NotFound' || err.name === '404' || err.name === 'NoSuchKey')) {
      logger.debug({ key }, 'File not found in S3 (HeadObject), skipping');
    } else {
      throw err;
    }
  }
}

/**
 * ListObjectsV2 + ETag comparison for directories.
 * Downloads changed/new files, deletes local files whose S3 keys disappeared.
 */
async function downloadDirectoryIncremental(
  s3: S3Client,
  bucket: string,
  prefix: string,
  localDir: string,
  logger: pino.Logger,
  state: SyncState,
): Promise<void> {
  // Get previous downloaded keys for this prefix
  const previousKeys = new Set(state.getDownloadedKeys(prefix));

  // Clear downloaded keys for this prefix — we will rebuild from the current listing
  state.clearDownloadedKeys(prefix);

  const currentKeys = new Set<string>();
  let continuationToken: string | undefined;

  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const obj of resp.Contents ?? []) {
      if (!obj.Key) continue;
      const rel = obj.Key.slice(prefix.length).replace(/^\/+/, '');
      if (!rel) continue;
      if (isExcludedPath(rel)) continue;

      currentKeys.add(obj.Key);
      state.recordDownloadedKey(prefix, obj.Key);

      // Check ETag — skip if unchanged
      const cachedEtag = state.getEtag(obj.Key);
      if (obj.ETag && cachedEtag === obj.ETag) {
        logger.debug({ key: obj.Key, etag: obj.ETag }, 'ETag unchanged, skipping download');
        continue;
      }

      // Changed or new — download and update ETag
      await downloadFile(s3, bucket, obj.Key, join(localDir, rel), logger, state);
      if (obj.ETag) {
        state.recordEtag(obj.Key, obj.ETag);
      }
    }

    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  // Delete local files whose S3 keys disappeared (e.g., removed via web console)
  for (const prevKey of previousKeys) {
    if (!currentKeys.has(prevKey)) {
      const rel = prevKey.slice(prefix.length).replace(/^\/+/, '');
      if (!rel) continue;
      const localPath = join(localDir, rel);
      try {
        await unlink(localPath);
        logger.debug({ key: prevKey, localPath }, 'Deleted local file (S3 key removed)');
      } catch {
        // File may not exist locally — ignore
      }
      // Clear stale ETag
      state.deleteEtag(prevKey);
    }
  }
}

async function deleteS3Object(
  s3: S3Client,
  bucket: string,
  key: string,
  logger: pino.Logger,
): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    logger.debug({ key }, 'Deleted S3 object');
  } catch {
    // Best effort — object may not exist
  }
}

async function downloadFile(
  s3: S3Client,
  bucket: string,
  key: string,
  localPath: string,
  logger: pino.Logger,
  state?: SyncState,
): Promise<void> {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (resp.Body) {
      await mkdir(dirname(localPath), { recursive: true });
      const bytes = await resp.Body.transformToByteArray();
      await writeFile(localPath, Buffer.from(bytes));
      logger.debug({ key, localPath }, 'Downloaded file');
      if (state && resp.ETag) {
        state.recordEtag(key, resp.ETag);
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'NoSuchKey') {
      logger.debug({ key }, 'File not found in S3, skipping');
    } else {
      throw err;
    }
  }
}

async function downloadDirectory(
  s3: S3Client,
  bucket: string,
  prefix: string,
  localDir: string,
  logger: pino.Logger,
  state?: SyncState,
): Promise<void> {
  let continuationToken: string | undefined;

  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const obj of resp.Contents ?? []) {
      if (!obj.Key) continue;
      const rel = obj.Key.slice(prefix.length).replace(/^\/+/, '');
      if (!rel) continue;
      // Skip excluded directories (.git, node_modules, etc.)
      if (isExcludedPath(rel)) continue;
      // Record ETag from ListObjectsV2 response (available without extra call)
      if (state && obj.ETag) {
        state.recordEtag(obj.Key, obj.ETag);
      }
      if (state) {
        state.recordDownloadedKey(prefix, obj.Key);
      }
      await downloadFile(s3, bucket, obj.Key, join(localDir, rel), logger, state);
    }

    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);
}

async function uploadFile(
  s3: S3Client,
  bucket: string,
  localPath: string,
  key: string,
  logger: pino.Logger,
  state?: SyncState,
): Promise<void> {
  try {
    const content = await readFile(localPath);
    const resp = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content }));
    logger.debug({ key, localPath }, 'Uploaded file');
    if (state && resp.ETag) {
      state.recordEtag(key, resp.ETag);
    }
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ localPath }, 'Local file not found, skipping upload');
    } else {
      throw err;
    }
  }
}

/** Allowed path prefixes for symlink targets — prevent exfiltration of host files */
const ALLOWED_SYMLINK_ROOTS = ['/home/node/', '/workspace/'];

async function uploadDirectory(
  s3: S3Client,
  bucket: string,
  localDir: string,
  prefix: string,
  logger: pino.Logger,
  visited?: Set<string>,
  state?: SyncState,
): Promise<void> {
  // Circular symlink protection: track canonical paths already visited
  const canonical = await realpath(localDir).catch(() => localDir);
  const seen = visited ?? new Set<string>();
  if (seen.has(canonical)) {
    logger.debug({ localDir, canonical }, 'Circular symlink detected, skipping');
    return;
  }
  seen.add(canonical);

  try {
    const entries = await readdir(localDir, { recursive: true, withFileTypes: true });
    // Track which relative paths readdir already yielded as files (via symlink follow)
    // to avoid duplicate uploads when readdir traverses into symlinked dirs on some platforms.
    const uploadedRels = new Set<string>();

    for (const entry of entries) {
      const fullPath = join(entry.parentPath ?? '', entry.name);
      const rel = relative(localDir, fullPath);

      // Skip excluded directories (.git, node_modules, etc.)
      if (isExcludedPath(rel)) continue;

      if (entry.isFile()) {
        uploadedRels.add(rel);
        await uploadFile(s3, bucket, fullPath, prefix + rel, logger, state);
      } else if (entry.isSymbolicLink()) {
        // Symlinks (e.g. skills installed by Claude Code) may point to
        // directories outside the sync root. Resolve and upload the target.
        try {
          const realTarget = await realpath(fullPath);

          // Security: only follow symlinks that resolve within allowed paths
          if (!ALLOWED_SYMLINK_ROOTS.some((root) => realTarget.startsWith(root))) {
            logger.warn({ fullPath, realTarget }, 'Symlink target outside allowed paths, skipping');
            continue;
          }

          const targetStat = await stat(realTarget);
          if (targetStat.isFile()) {
            if (!uploadedRels.has(rel)) {
              await uploadFile(s3, bucket, realTarget, prefix + rel, logger, state);
            }
          } else if (targetStat.isDirectory()) {
            // Only recurse if readdir didn't already yield children for this path
            const childPrefix = rel + '/';
            const alreadyTraversed = [...uploadedRels].some((r) => r.startsWith(childPrefix));
            if (!alreadyTraversed) {
              await uploadDirectory(s3, bucket, realTarget, prefix + rel + '/', logger, seen, state);
            }
          }
        } catch (err) {
          logger.debug(
            { fullPath, error: err instanceof Error ? err.message : String(err) },
            'Broken or inaccessible symlink, skipping',
          );
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ localDir }, 'Directory not found, skipping upload');
    } else {
      throw err;
    }
  }
}
