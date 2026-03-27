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

import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { existsSync } from 'fs';
import { mkdir, readdir, readFile, writeFile, stat, realpath } from 'fs/promises';
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
): Promise<void> {
  // 1. Download session directory → /home/node/.claude/
  await downloadDirectory(s3, bucket, paths.sessionPath, CLAUDE_DIR, logger);

  // 2. Download bot CLAUDE.md → /home/node/.claude/CLAUDE.md
  await downloadFile(s3, bucket, paths.botClaude, join(CLAUDE_DIR, 'CLAUDE.md'), logger);

  // 3. Download entire group workspace → /workspace/group/
  await downloadDirectory(s3, bucket, paths.groupPrefix, join(WORKSPACE_BASE, 'group'), logger);

  // 4. Download learnings → /workspace/learnings/
  if (paths.learningsPrefix) {
    await downloadDirectory(s3, bucket, paths.learningsPrefix, join(WORKSPACE_BASE, 'learnings'), logger);
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
): Promise<void> {
  // 1. Upload session directory (Claude Code state)
  await uploadDirectory(s3, bucket, CLAUDE_DIR, paths.sessionPath, logger);

  // 2. Upload bot CLAUDE.md from /home/node/.claude/CLAUDE.md → S3
  await uploadFile(s3, bucket, join(CLAUDE_DIR, 'CLAUDE.md'), paths.botClaude, logger);

  // 3. Upload entire group workspace → S3
  await uploadDirectory(s3, bucket, join(WORKSPACE_BASE, 'group'), paths.groupPrefix, logger);

  // 4. Upload learnings directory
  if (paths.learningsPrefix) {
    await uploadDirectory(s3, bucket, join(WORKSPACE_BASE, 'learnings'), paths.learningsPrefix, logger);
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
): Promise<void> {
  // Skip step 1 (session directory) — that's the incompatible data

  // 2. Download bot CLAUDE.md
  await downloadFile(s3, bucket, paths.botClaude, join(CLAUDE_DIR, 'CLAUDE.md'), logger);

  // 3. Download group workspace
  await downloadDirectory(s3, bucket, paths.groupPrefix, join(WORKSPACE_BASE, 'group'), logger);

  // 4. Download learnings
  if (paths.learningsPrefix) {
    await downloadDirectory(s3, bucket, paths.learningsPrefix, join(WORKSPACE_BASE, 'learnings'), logger);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Directory names that should never be synced to/from S3. */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__']);

/**
 * Check if a relative path contains an excluded directory segment.
 * e.g. "foo/.git/objects/pack.idx" → true, "foo/bar.txt" → false
 */
function isExcludedPath(relPath: string): boolean {
  return relPath.split('/').some((seg) => EXCLUDED_DIRS.has(seg));
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
): Promise<void> {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (resp.Body) {
      await mkdir(dirname(localPath), { recursive: true });
      const bytes = await resp.Body.transformToByteArray();
      await writeFile(localPath, Buffer.from(bytes));
      logger.debug({ key, localPath }, 'Downloaded file');
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
      await downloadFile(s3, bucket, obj.Key, join(localDir, rel), logger);
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
): Promise<void> {
  try {
    const content = await readFile(localPath);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content }));
    logger.debug({ key, localPath }, 'Uploaded file');
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
      const fullPath = join(entry.parentPath || entry.path, entry.name);
      const rel = relative(localDir, fullPath);

      // Skip excluded directories (.git, node_modules, etc.)
      if (isExcludedPath(rel)) continue;

      if (entry.isFile()) {
        uploadedRels.add(rel);
        await uploadFile(s3, bucket, fullPath, prefix + rel, logger);
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
              await uploadFile(s3, bucket, realTarget, prefix + rel, logger);
            }
          } else if (targetStat.isDirectory()) {
            // Only recurse if readdir didn't already yield children for this path
            const childPrefix = rel + '/';
            const alreadyTraversed = [...uploadedRels].some((r) => r.startsWith(childPrefix));
            if (!alreadyTraversed) {
              await uploadDirectory(s3, bucket, realTarget, prefix + rel + '/', logger, seen);
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
