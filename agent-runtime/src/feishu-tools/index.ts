/**
 * ClawBot Cloud — Feishu MCP Tool Registration Entry Point
 *
 * Conditionally registers Feishu/Lark document tools on the MCP server
 * based on available credentials and the enabled tool configuration.
 *
 * Individual tool implementations (doc, wiki, drive, perm) are registered
 * by their respective modules — Tasks 6/7 provide the full implementations.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type * as Lark from '@larksuiteoapi/node-sdk';
import { getOrCreateLarkClient, type FeishuToolConfig } from './client.js';

// ── Placeholder tool registration stubs ──────────────────────────────────────
// These will be replaced with real implementations in Tasks 6 and 7.

export function registerDocTool(_server: McpServer, _client: Lark.Client): void {
  // Placeholder — implemented in Task 7 (feishu_doc)
}

export function registerWikiTool(_server: McpServer, _client: Lark.Client): void {
  // Placeholder — implemented in Task 7 (feishu_wiki)
}

export function registerDriveTool(_server: McpServer, _client: Lark.Client): void {
  // Placeholder — implemented in Task 8 (feishu_drive)
}

export function registerPermTool(_server: McpServer, _client: Lark.Client): void {
  // Placeholder — implemented in Task 8 (feishu_perm)
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Register Feishu/Lark MCP tools on the given MCP server.
 *
 * @param server          - The MCP server instance to register tools on
 * @param feishuCredentials - Lark app credentials (null = skip registration)
 * @param enabledTools    - Which tool categories to enable
 */
export async function registerFeishuTools(
  server: McpServer,
  feishuCredentials: { appId: string; appSecret: string; domain?: string } | null,
  enabledTools: FeishuToolConfig,
): Promise<void> {
  if (!feishuCredentials) return;

  const client = getOrCreateLarkClient(
    feishuCredentials.appId,
    feishuCredentials.appSecret,
    feishuCredentials.domain ?? 'feishu',
  );

  if (enabledTools.doc) registerDocTool(server, client);
  if (enabledTools.wiki) registerWikiTool(server, client);
  if (enabledTools.drive) registerDriveTool(server, client);
  if (enabledTools.perm) registerPermTool(server, client);
}

export type { FeishuToolConfig } from './client.js';
