/**
 * Skills Service — Handles skill package installation from zip uploads and git repos.
 * Skills are stored flat in S3 at skills/{skillDirName}/ (no ULID, no plugin grouping).
 * A single Skill record can map to multiple S3 prefixes (e.g., a plugin with 2 skills).
 */

import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import AdmZip from 'adm-zip';
import { ulid } from 'ulid';
import { config } from '../config.js';
import { createSkill, getSkillByPrefix } from './dynamo.js';
import type { Skill } from '@clawbot/shared';

const execFileAsync = promisify(execFile);
const s3 = new S3Client({ region: config.region });

const MAX_ZIP_SIZE = 10 * 1024 * 1024; // 10MB

/** Directories to skip when scanning skill packages. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', '__MACOSX', '.claude-plugin']);

/**
 * Recursively find all files in a directory (skips OS artifacts and VCS dirs).
 */
async function findAllFiles(dir: string, base = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      files.push(...await findAllFiles(join(dir, entry.name), rel));
    } else {
      // Skip macOS artifacts (._*, .DS_Store, Thumbs.db)
      if (entry.name.startsWith('._') || entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
      files.push(rel);
    }
  }
  return files;
}

/** Guess MIME type from file extension. */
function contentType(filePath: string): string {
  if (filePath.endsWith('.md')) return 'text/markdown';
  if (filePath.endsWith('.py')) return 'text/x-python';
  if (filePath.endsWith('.js')) return 'application/javascript';
  if (filePath.endsWith('.json')) return 'application/json';
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) return 'text/yaml';
  if (filePath.endsWith('.sh')) return 'text/x-shellscript';
  if (filePath.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

/**
 * Detect skill directory names from extracted files.
 * Returns the list of top-level directories that contain skill files.
 * For a single-skill zip (email-manager/SKILL.md) → ["email-manager"]
 * For a multi-skill plugin (ms-swift/SKILL.md, llamafactory/SKILL.md) → ["ms-swift", "llamafactory"]
 * For flat files (SKILL.md at root) → uses slugified name as wrapper
 */
function detectSkillDirs(allFiles: string[], skillName: string): string[] {
  // Get unique top-level directories
  const topDirs = new Set<string>();
  for (const f of allFiles) {
    if (f.includes('/')) {
      topDirs.add(f.split('/')[0]);
    }
  }

  if (topDirs.size > 0 && allFiles.every((f) => f.includes('/'))) {
    // All files are under subdirectories — use those as skill dirs
    return [...topDirs].sort();
  }

  // Files at root level — wrap with slugified name
  return [skillName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')];
}

/**
 * Upload files to S3 as flat skill directories under skills/.
 * Each skill dir (e.g., ms-swift, email-manager) sits directly under skills/.
 */
async function uploadSkillFiles(
  sourceDir: string,
  allFiles: string[],
  skillDirs: string[],
): Promise<void> {
  const hasNaturalDirs = allFiles.every((f) => f.includes('/'));

  for (const file of allFiles) {
    // If files have natural subdirectories, upload as-is: skills/ms-swift/SKILL.md
    // If files are at root, wrap: skills/{slugName}/SKILL.md
    const s3Key = hasNaturalDirs
      ? `skills/${file}`
      : `skills/${skillDirs[0]}/${file}`;
    const content = await readFile(join(sourceDir, file));
    await s3.send(
      new PutObjectCommand({
        Bucket: config.s3Bucket,
        Key: s3Key,
        Body: content,
        ContentType: contentType(file),
      }),
    );
  }
}

/**
 * Check that none of the skill directory names collide with existing skills.
 */
async function checkPrefixCollisions(skillDirs: string[]): Promise<void> {
  for (const dir of skillDirs) {
    const existing = await getSkillByPrefix(dir);
    if (existing) {
      throw new Error(`Skill directory "${dir}" is already used by skill "${existing.name}" (${existing.skillId}). Delete the existing skill first.`);
    }
  }
}

/**
 * Install a skill from a zip buffer.
 */
export async function installFromZip(
  buffer: Buffer,
  name: string,
  description: string,
  version: string,
  adminUserId: string,
): Promise<Skill> {
  if (buffer.length > MAX_ZIP_SIZE) {
    throw new Error(`Zip file exceeds maximum size of ${MAX_ZIP_SIZE / 1024 / 1024}MB`);
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'skill-zip-'));
  try {
    const zip = new AdmZip(buffer);
    zip.extractAllTo(tmpDir, true);

    const allFiles = await findAllFiles(tmpDir);
    const mdFiles = allFiles.filter((f) => f.endsWith('.md'));
    if (mdFiles.length === 0) {
      throw new Error('No .md files found in zip archive');
    }

    const skillDirs = detectSkillDirs(allFiles, name);
    await checkPrefixCollisions(skillDirs);

    const skillId = ulid();
    await uploadSkillFiles(tmpDir, allFiles, skillDirs);

    const now = new Date().toISOString();
    const skill: Skill = {
      skillId,
      name,
      description,
      version,
      source: 'zip',
      s3Prefixes: skillDirs,
      fileCount: allFiles.length,
      files: allFiles,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      createdBy: adminUserId,
    };

    await createSkill(skill);
    return skill;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Marketplace plugin descriptor.
 */
interface MarketplaceJson {
  name: string;
  plugins: Array<{
    name: string;
    source: string;
    description?: string;
  }>;
}

/**
 * Install a skill from a git repository URL.
 * If the repo contains .claude-plugin/marketplace.json, auto-discovers plugins
 * and uses their skills/ subdirectory. Otherwise falls back to subPath + name.
 */
export async function installFromGit(
  url: string,
  subPath: string | undefined,
  name: string,
  description: string,
  version: string,
  adminUserId: string,
): Promise<Skill> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'skill-git-'));
  try {
    await execFileAsync('git', ['clone', '--depth', '1', url, tmpDir], {
      timeout: 60_000,
    });

    // Try to auto-discover plugins from marketplace.json
    const marketplacePath = join(tmpDir, '.claude-plugin', 'marketplace.json');
    let sourceDir: string;
    let pluginName = name;
    let pluginDesc = description;

    if (existsSync(marketplacePath) && !subPath) {
      const marketplace: MarketplaceJson = JSON.parse(await readFile(marketplacePath, 'utf-8'));
      if (marketplace.plugins?.length > 0) {
        if (marketplace.plugins.length > 1) {
          console.warn(
            `marketplace.json has ${marketplace.plugins.length} plugins, installing only the first: "${marketplace.plugins[0].name}". ` +
            `Use subPath to install others: ${marketplace.plugins.map((p) => p.source).join(', ')}`,
          );
        }
        const plugin = marketplace.plugins[0];
        pluginName = plugin.name || name;
        pluginDesc = plugin.description || description;
        const pluginSource = join(tmpDir, plugin.source);
        const skillsDir = join(pluginSource, 'skills');
        sourceDir = existsSync(skillsDir) ? skillsDir : pluginSource;
      } else {
        sourceDir = tmpDir;
      }
    } else {
      sourceDir = subPath ? join(tmpDir, subPath) : tmpDir;
    }

    const resolved = resolve(sourceDir);
    if (!resolved.startsWith(tmpDir)) {
      throw new Error('Subdirectory path escapes the repository root');
    }

    const allFiles = await findAllFiles(resolved);
    const mdFiles = allFiles.filter((f) => f.endsWith('.md'));
    if (mdFiles.length === 0) {
      throw new Error('No .md files found in git repository' + (subPath ? ` at path "${subPath}"` : ''));
    }

    const skillDirs = detectSkillDirs(allFiles, pluginName);
    await checkPrefixCollisions(skillDirs);

    const skillId = ulid();
    await uploadSkillFiles(resolved, allFiles, skillDirs);

    const now = new Date().toISOString();
    const skill: Skill = {
      skillId,
      name: pluginName,
      description: pluginDesc,
      version,
      source: 'git',
      sourceUrl: url,
      s3Prefixes: skillDirs,
      fileCount: allFiles.length,
      files: allFiles,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      createdBy: adminUserId,
    };

    await createSkill(skill);
    return skill;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Delete all S3 objects for a skill's prefixes.
 */
export async function deleteSkillFiles(s3Prefixes: string[]): Promise<void> {
  for (const prefix of s3Prefixes) {
    const s3Prefix = `skills/${prefix}/`;
    let continuationToken: string | undefined;
    do {
      const listed = await s3.send(
        new ListObjectsV2Command({
          Bucket: config.s3Bucket,
          Prefix: s3Prefix,
          ContinuationToken: continuationToken,
        }),
      );

      if (listed.Contents?.length) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: config.s3Bucket,
            Delete: {
              Objects: listed.Contents.map((obj) => ({ Key: obj.Key! })),
            },
          }),
        );
      }

      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  }
}
