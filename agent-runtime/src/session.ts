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

import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
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
  // 1. Download session directory → /home/node/.claude/, keeping only the
  //    most-recent JSONL per Claude project (older transcripts accumulate in
  //    S3 over model switches; SDK `continue: true` only ever uses the latest)
  await downloadSessionDirectory(s3, bucket, paths.sessionPath, CLAUDE_DIR, logger, state);

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
 * Incremental download: skip session state, re-download only changed memory files.
 *
 * Used on subsequent requests within the same microVM/task lifetime.
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

import { isExcludedPath } from './sync-utils.js';

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
      // If we previously had this file (ETag cached), it was deleted from S3 (e.g., web console).
      // Delete the local copy to stay in sync.
      if (state.getEtag(key)) {
        try {
          await unlink(localPath);
          logger.info({ key, localPath }, 'Deleted local file (S3 key removed)');
        } catch { /* file may already be gone */ }
        state.deleteEtag(key);
      } else {
        logger.debug({ key }, 'File not found in S3 (HeadObject), skipping');
      }
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

/** Matches Claude Code session transcripts: `projects/<hash>/<sessionId>.jsonl`. */
const SESSION_JSONL_RE = /^projects\/[^/]+\/[^/]+\.jsonl$/;

/**
 * Variant of downloadDirectory for the session prefix. Identical to
 * downloadDirectory except that for each `projects/<hash>/` directory we keep
 * only the most-recently-modified `.jsonl`. Older session transcripts
 * accumulate in S3 whenever the user switches models (SDK `continue: false`
 * creates a new sessionId). The SDK's `continue: true` only picks the latest
 * one, so downloading stale JSONLs is pure I/O waste.
 *
 * Everything outside the JSONL pattern (settings.json, sessions-index.json,
 * skills/, etc.) is downloaded as-is.
 */
async function downloadSessionDirectory(
  s3: S3Client,
  bucket: string,
  prefix: string,
  localDir: string,
  logger: pino.Logger,
  state?: SyncState,
): Promise<void> {
  // Collect all objects (ListObjectsV2 yields LastModified + ETag without extra calls)
  const objects: Array<{ key: string; rel: string; lastModified?: Date; etag?: string }> = [];
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
      objects.push({ key: obj.Key, rel, lastModified: obj.LastModified, etag: obj.ETag });
    }

    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  // Partition: session JSONLs (pick latest per project) vs. everything else
  const latestByProject = new Map<string, typeof objects[number]>();
  const others: typeof objects = [];

  for (const obj of objects) {
    if (SESSION_JSONL_RE.test(obj.rel)) {
      const projectDir = obj.rel.split('/', 2).join('/'); // projects/<hash>
      const current = latestByProject.get(projectDir);
      const isNewer = !current
        || (obj.lastModified && current.lastModified
            ? obj.lastModified.getTime() > current.lastModified.getTime()
            : !!obj.lastModified);
      if (isNewer) latestByProject.set(projectDir, obj);
    } else {
      others.push(obj);
    }
  }

  const skipped = objects.length - others.length - latestByProject.size;
  if (skipped > 0) {
    logger.info(
      { skipped, keptJsonl: latestByProject.size, prefix },
      'Skipped non-current session JSONLs on first-request sync',
    );
  }

  for (const obj of [...others, ...latestByProject.values()]) {
    if (state && obj.etag) state.recordEtag(obj.key, obj.etag);
    if (state) state.recordDownloadedKey(prefix, obj.key);
    await downloadFile(s3, bucket, obj.key, join(localDir, obj.rel), logger, state);
  }
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

/**
 * Check a single local file against the snapshot. Upload only if mtime or size changed.
 */
async function uploadFileIfChanged(
  s3: S3Client,
  bucket: string,
  localPath: string,
  key: string,
  logger: pino.Logger,
  state: SyncState,
): Promise<void> {
  try {
    const st = await stat(localPath);
    const snap = state.getSnapshotEntry(localPath);

    if (snap && snap.mtimeMs === st.mtimeMs && snap.size === st.size) {
      logger.debug({ localPath, key }, 'File unchanged (mtime + size match snapshot), skipping upload');
      return;
    }

    await uploadFile(s3, bucket, localPath, key, logger, state);
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist locally — skip silently
      return;
    }
    throw err;
  }
}

/**
 * Walk directory, upload only files that changed vs snapshot.
 */
async function uploadDirectoryIncremental(
  s3: S3Client,
  bucket: string,
  localDir: string,
  prefix: string,
  logger: pino.Logger,
  state: SyncState,
): Promise<void> {
  try {
    const entries = await readdir(localDir, { recursive: true, withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const fullPath = join(entry.parentPath ?? '', entry.name);
      const rel = relative(localDir, fullPath);

      if (isExcludedPath(rel)) continue;

      try {
        const st = await stat(fullPath);
        const snap = state.getSnapshotEntry(fullPath);

        if (snap && snap.mtimeMs === st.mtimeMs && snap.size === st.size) {
          logger.debug({ fullPath, key: prefix + rel }, 'File unchanged, skipping upload');
          continue;
        }

        await uploadFile(s3, bucket, fullPath, prefix + rel, logger, state);
      } catch (err: unknown) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          // File vanished between readdir and stat — skip
          continue;
        }
        throw err;
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Directory doesn't exist — skip silently
      return;
    }
    throw err;
  }
}

/**
 * Incremental upload: upload only files changed since the snapshot, and delete
 * S3 objects for files that the agent deleted locally.
 *
 * Used after agent invocation when SyncState has a pre-run snapshot.
 */
export async function incrementalSyncToS3(
  s3: S3Client,
  bucket: string,
  paths: SyncPaths,
  logger: pino.Logger,
  state: SyncState,
): Promise<void> {
  // 1. Upload each sync directory incrementally

  // Session dir (CLAUDE_DIR → paths.sessionPath)
  await uploadDirectoryIncremental(s3, bucket, CLAUDE_DIR, paths.sessionPath, logger, state);

  // Bot CLAUDE.md (single file)
  await uploadFileIfChanged(s3, bucket, join(CLAUDE_DIR, 'CLAUDE.md'), paths.botClaude, logger, state);

  // Group workspace (/workspace/group → paths.groupPrefix)
  await uploadDirectoryIncremental(s3, bucket, join(WORKSPACE_BASE, 'group'), paths.groupPrefix, logger, state);

  // Learnings if present (/workspace/learnings → paths.learningsPrefix)
  if (paths.learningsPrefix) {
    await uploadDirectoryIncremental(s3, bucket, join(WORKSPACE_BASE, 'learnings'), paths.learningsPrefix, logger, state);
  }

  // Note: local file deletions are NOT propagated to S3. S3 is the source of
  // truth — if the agent deletes a file locally, it will be restored on the
  // next full sync (fresh microVM/task). Only S3-side deletions propagate to
  // local (handled in downloadDirectoryIncremental / downloadFileIfChanged).
}
