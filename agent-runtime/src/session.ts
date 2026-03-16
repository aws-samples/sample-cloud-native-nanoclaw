/**
 * ClawBot Cloud — S3 Session Sync
 *
 * Replaces NanoClaw's Docker volume mounts with S3 round-trips:
 *   Before invocation → download session + memory files from S3
 *   After invocation  → upload changed files back to S3
 *
 * Layout mirrors NanoClaw's /workspace:
 *   /home/node/.claude/   ← Claude Code session state (conversations, settings)
 *   /workspace/group/     ← Group memory + conversations (read-write)
 *   /workspace/global/    ← Bot-wide memory (read-only at runtime)
 *   /workspace/shared/    ← User-shared memory (read-only at runtime)
 */

import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import type pino from 'pino';

const WORKSPACE_BASE = '/workspace';
const CLAUDE_DIR = '/home/node/.claude';

export interface SyncPaths {
  /** S3 prefix for Claude Code session files (conversations, etc.) */
  sessionPath: string;
  /** S3 key for group CLAUDE.md (read-write) */
  groupMemory: string;
  /** S3 key for bot global CLAUDE.md (read-only) */
  botGlobalMemory: string;
  /** S3 key for user shared CLAUDE.md (read-only) */
  sharedMemory: string;
  /** S3 key for PERSONA.md — bot identity + tone (read-only) */
  personaFile?: string;
  /** S3 key for BOOTSTRAP.md — new-session-only instructions (read-only) */
  bootstrapFile?: string;
  /** S3 key for USER.md — about the humans in this conversation (read-only) */
  userFile?: string;
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

  // 2. Download group memory → /workspace/group/CLAUDE.md (read-write)
  await downloadFile(s3, bucket, paths.groupMemory, join(WORKSPACE_BASE, 'group', 'CLAUDE.md'), logger);

  // 3. Download bot global memory → /workspace/global/CLAUDE.md (read-only)
  await downloadFile(s3, bucket, paths.botGlobalMemory, join(WORKSPACE_BASE, 'global', 'CLAUDE.md'), logger);

  // 4. Download shared memory → /workspace/shared/CLAUDE.md (read-only)
  await downloadFile(s3, bucket, paths.sharedMemory, join(WORKSPACE_BASE, 'shared', 'CLAUDE.md'), logger);

  // 5. Download PERSONA.md → /workspace/persona/PERSONA.md (read-only)
  if (paths.personaFile) {
    await downloadFile(s3, bucket, paths.personaFile, join(WORKSPACE_BASE, 'persona', 'PERSONA.md'), logger);
  }

  // 6. Download BOOTSTRAP.md → /workspace/persona/BOOTSTRAP.md (read-only)
  if (paths.bootstrapFile) {
    await downloadFile(s3, bucket, paths.bootstrapFile, join(WORKSPACE_BASE, 'persona', 'BOOTSTRAP.md'), logger);
  }

  // 7. Download USER.md → /workspace/group/USER.md (read-only)
  if (paths.userFile) {
    await downloadFile(s3, bucket, paths.userFile, join(WORKSPACE_BASE, 'group', 'USER.md'), logger);
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

  // 2. Upload group memory (only writable layer)
  await uploadFile(s3, bucket, join(WORKSPACE_BASE, 'group', 'CLAUDE.md'), paths.groupMemory, logger);

  // 3. Upload group conversations directory (archived transcripts)
  const conversationsDir = join(WORKSPACE_BASE, 'group', 'conversations');
  const conversationsPrefix = paths.groupMemory.replace(/CLAUDE\.md$/, 'conversations/');
  await uploadDirectory(s3, bucket, conversationsDir, conversationsPrefix, logger);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
      const content = await resp.Body.transformToString();
      await writeFile(localPath, content, 'utf-8');
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
      const relativePath = obj.Key.slice(prefix.length);
      if (!relativePath) continue;
      await downloadFile(s3, bucket, obj.Key, join(localDir, relativePath), logger);
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
    const content = await readFile(localPath, 'utf-8');
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

async function uploadDirectory(
  s3: S3Client,
  bucket: string,
  localDir: string,
  prefix: string,
  logger: pino.Logger,
): Promise<void> {
  try {
    const entries = await readdir(localDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = join(entry.parentPath || entry.path, entry.name);
      const relativePath = fullPath.slice(localDir.length);
      await uploadFile(s3, bucket, fullPath, prefix + relativePath, logger);
    }
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ localDir }, 'Directory not found, skipping upload');
    } else {
      throw err;
    }
  }
}
