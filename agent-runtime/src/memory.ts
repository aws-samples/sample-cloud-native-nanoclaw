/**
 * ClawBot Cloud — Multi-layer Memory Loading with Token Budgeting
 *
 * Memory hierarchy:
 *   Layer 1: Shared memory   (read-only, user-wide across all bots)
 *   Layer 2: Bot global      (read-only, bot-wide across all groups)
 *   Layer 3: Group memory    (read-write, per conversation)
 *
 * Additional context files:
 *   PERSONA.md   (bot-level identity + tone)
 *   BOOTSTRAP.md (bot-level, new-session-only instructions)
 *   USER.md      (group-level, about the humans)
 *
 * Token budgeting prevents large files from blowing the context window.
 * Truncation strategy: keep 70% head + 20% tail + [...truncated...] marker.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

const WORKSPACE_BASE = '/workspace';

// ── Truncation Config ─────────────────────────────────────────────────────

export interface TruncationConfig {
  /** Max characters per file (default 20,000) */
  perFileCap: number;
  /** Max characters for all memory layers combined (default 100,000) */
  totalCap: number;
  /** Fraction of budget kept from the start of the file (default 0.7) */
  headRatio: number;
  /** Fraction of budget kept from the end of the file (default 0.2) */
  tailRatio: number;
}

export const DEFAULT_TRUNCATION: TruncationConfig = {
  perFileCap: 20_000,
  totalCap: 100_000,
  headRatio: 0.7,
  tailRatio: 0.2,
};

/**
 * Truncate content to fit within a character budget.
 * Keeps headRatio from the start and tailRatio from the end,
 * inserting a [...truncated...] marker in between.
 */
export function truncateContent(
  content: string,
  maxChars: number,
  config: TruncationConfig = DEFAULT_TRUNCATION,
): string {
  if (content.length <= maxChars) return content;

  const marker = '\n\n[...truncated...]\n\n';

  // Guard: if budget is too small for marker, just hard-slice
  if (maxChars <= marker.length) return content.slice(0, Math.max(0, maxChars));

  // Account for marker length in the budget
  const available = maxChars - marker.length;
  const headSize = Math.floor(available * config.headRatio);
  const tailSize = Math.floor(available * config.tailRatio);

  const head = content.slice(0, headSize);
  const tail = content.slice(-tailSize);

  return head + marker + tail;
}

// ── Memory Layer Loading ──────────────────────────────────────────────────

export interface MemoryLayer {
  label: string;
  content: string;
}

export interface MemoryLayerResult {
  layers: MemoryLayer[];
  totalChars: number;
}

/**
 * Load all three CLAUDE.md memory layers with token budgeting.
 * Returns structured layers (not concatenated) so the system prompt
 * builder can format them.
 */
export async function loadMemoryLayers(
  config: TruncationConfig = DEFAULT_TRUNCATION,
): Promise<MemoryLayerResult> {
  const entries = [
    { label: '# Shared Memory', path: join(WORKSPACE_BASE, 'shared', 'CLAUDE.md') },
    { label: '# Bot Memory', path: join(WORKSPACE_BASE, 'global', 'CLAUDE.md') },
    { label: '# Group Memory', path: join(WORKSPACE_BASE, 'group', 'CLAUDE.md') },
  ];

  const layers: MemoryLayer[] = [];
  let totalChars = 0;

  for (const entry of entries) {
    let content = await safeReadFile(entry.path);
    if (!content) continue;

    // Per-file cap
    content = truncateContent(content, config.perFileCap, config);

    // Total cap check
    if (totalChars + content.length > config.totalCap) {
      const remaining = config.totalCap - totalChars;
      if (remaining <= 0) break;
      content = truncateContent(content, remaining, config);
    }

    totalChars += content.length;
    layers.push({ label: entry.label, content });
  }

  return { layers, totalChars };
}

// ── Context File Loaders ──────────────────────────────────────────────────

/** Load PERSONA.md (bot-level identity + tone) */
export async function loadPersonaFile(): Promise<string | null> {
  return safeReadFile(join(WORKSPACE_BASE, 'persona', 'PERSONA.md'));
}

/** Load BOOTSTRAP.md (bot-level, new-session-only instructions) */
export async function loadBootstrapFile(): Promise<string | null> {
  return safeReadFile(join(WORKSPACE_BASE, 'persona', 'BOOTSTRAP.md'));
}

/** Load USER.md (group-level, about the humans in this conversation) */
export async function loadUserFile(): Promise<string | null> {
  return safeReadFile(join(WORKSPACE_BASE, 'group', 'USER.md'));
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function safeReadFile(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}
