/**
 * ClawBot Cloud — Lark/Feishu Client Management
 *
 * Creates and caches Lark SDK clients keyed by appId.
 * Used by feishu MCP tools (doc, wiki, drive, perm) in the agent runtime.
 */

import * as Lark from '@larksuiteoapi/node-sdk';

// ── Types ────────────────────────────────────────────────────────────────────

/** Which Feishu MCP tool categories are enabled for this invocation. */
export interface FeishuToolConfig {
  doc: boolean;
  wiki: boolean;
  drive: boolean;
  perm: boolean;
}

// ── Client Cache ─────────────────────────────────────────────────────────────

const clientCache = new Map<string, Lark.Client>();

/**
 * Resolve a domain string to the Lark SDK Domain enum value.
 * 'feishu' → Lark.Domain.Feishu (default)
 * 'lark'   → Lark.Domain.Lark
 */
function resolveDomain(domain: string): Lark.Domain {
  if (domain === 'lark') return Lark.Domain.Lark;
  return Lark.Domain.Feishu;
}

/**
 * Get or create a cached Lark client for the given app credentials.
 * Clients are cached by appId to avoid unnecessary re-creation within
 * the same agent runtime container.
 */
export function getOrCreateLarkClient(
  appId: string,
  appSecret: string,
  domain: string = 'feishu',
): Lark.Client {
  const cached = clientCache.get(appId);
  if (cached) return cached;

  const client = new Lark.Client({
    appId,
    appSecret,
    domain: resolveDomain(domain),
    disableTokenCache: false,
  });

  clientCache.set(appId, client);
  return client;
}
