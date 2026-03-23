import { describe, it, expect, vi } from 'vitest';
import { createToolWhitelistHook } from '../tool-whitelist.js';
import type { InvocationPayload } from '@clawbot/shared';
import type pino from 'pino';

const mockLogger: pino.Logger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

const opts = { signal: AbortSignal.timeout(5000) };

function makePayload(
  overrides: { mcpToolsEnabled?: boolean; skillsEnabled?: boolean; allowedMcpTools?: string[]; allowedSkills?: string[] } = {},
): InvocationPayload {
  return {
    botId: 'bot-1',
    botName: 'TestBot',
    groupJid: 'tg:123',
    userId: 'user-1',
    channelType: 'telegram',
    prompt: 'test',
    sessionPath: 'user-1/bot-1/sessions/tg:123/',
    memoryPaths: {
      botClaude: 'user-1/bot-1/CLAUDE.md',
      groupPrefix: 'user-1/bot-1/workspace/tg:123/',
    },
    toolWhitelist: {
      mcpToolsEnabled: overrides.mcpToolsEnabled ?? true,
      skillsEnabled: overrides.skillsEnabled ?? true,
      allowedMcpTools: overrides.allowedMcpTools ?? [],
      allowedSkills: overrides.allowedSkills ?? [],
    },
  };
}

function hookInput(toolName: string, toolInput?: Record<string, unknown>) {
  return {
    session_id: 'test-session',
    transcript_path: '/tmp/transcript',
    cwd: '/workspace/group',
    hook_event_name: 'PreToolUse' as const,
    tool_name: toolName,
    tool_input: toolInput ?? {},
    tool_use_id: 'tu-1',
  };
}

describe('createToolWhitelistHook', () => {
  // ── MCP tool checks ─────────────────────────────────────────────

  it('allows an MCP tool that is in the whitelist', async () => {
    const hook = createToolWhitelistHook(
      makePayload({ mcpToolsEnabled: true, allowedMcpTools: ['send_message'] }),
      mockLogger,
    );
    const result = await hook(hookInput('mcp__nanoclawbot__send_message'), undefined, opts);
    expect(result).toEqual({});
  });

  it('denies an MCP tool that is NOT in the whitelist', async () => {
    const hook = createToolWhitelistHook(
      makePayload({ mcpToolsEnabled: true, allowedMcpTools: ['send_message'] }),
      mockLogger,
    );
    const result = await hook(hookInput('mcp__nanoclawbot__schedule_task'), undefined, opts);
    expect(result).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    expect(result).toHaveProperty('hookSpecificOutput.hookEventName', 'PreToolUse');
    expect((result as any).hookSpecificOutput.permissionDecisionReason).toContain('schedule_task');
  });

  it('denies all MCP tools when allowedMcpTools is empty', async () => {
    const hook = createToolWhitelistHook(
      makePayload({ mcpToolsEnabled: true, allowedMcpTools: [] }),
      mockLogger,
    );
    const result = await hook(hookInput('mcp__nanoclawbot__send_message'), undefined, opts);
    expect(result).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
  });

  it('allows all MCP tools when mcpToolsEnabled is false', async () => {
    const hook = createToolWhitelistHook(
      makePayload({ mcpToolsEnabled: false, allowedMcpTools: [] }),
      mockLogger,
    );
    const result = await hook(hookInput('mcp__nanoclawbot__send_message'), undefined, opts);
    expect(result).toEqual({});
  });

  // ── Skill checks ────────────────────────────────────────────────

  it('allows a skill that is in the whitelist', async () => {
    const hook = createToolWhitelistHook(
      makePayload({ skillsEnabled: true, allowedSkills: ['pdf', 'docx'] }),
      mockLogger,
    );
    const result = await hook(hookInput('Skill', { skill: 'pdf' }), undefined, opts);
    expect(result).toEqual({});
  });

  it('denies a skill that is NOT in the whitelist', async () => {
    const hook = createToolWhitelistHook(
      makePayload({ skillsEnabled: true, allowedSkills: ['pdf'] }),
      mockLogger,
    );
    const result = await hook(hookInput('Skill', { skill: 'agent-browser' }), undefined, opts);
    expect(result).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    expect((result as any).hookSpecificOutput.permissionDecisionReason).toContain('agent-browser');
  });

  it('denies all skills when allowedSkills is empty', async () => {
    const hook = createToolWhitelistHook(
      makePayload({ skillsEnabled: true, allowedSkills: [] }),
      mockLogger,
    );
    const result = await hook(hookInput('Skill', { skill: 'pdf' }), undefined, opts);
    expect(result).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
  });

  it('allows all skills when skillsEnabled is false', async () => {
    const hook = createToolWhitelistHook(
      makePayload({ skillsEnabled: false, allowedSkills: [] }),
      mockLogger,
    );
    const result = await hook(hookInput('Skill', { skill: 'pdf' }), undefined, opts);
    expect(result).toEqual({});
  });

  // ── Independent toggles ─────────────────────────────────────────

  it('enforces MCP whitelist while skills pass through when skillsEnabled is false', async () => {
    const hook = createToolWhitelistHook(
      makePayload({ mcpToolsEnabled: true, skillsEnabled: false, allowedMcpTools: ['send_message'] }),
      mockLogger,
    );
    // MCP tool not in list → denied
    const mcpResult = await hook(hookInput('mcp__nanoclawbot__schedule_task'), undefined, opts);
    expect(mcpResult).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    // Skill → allowed (skillsEnabled is false)
    const skillResult = await hook(hookInput('Skill', { skill: 'pdf' }), undefined, opts);
    expect(skillResult).toEqual({});
  });

  it('enforces skill whitelist while MCP tools pass through when mcpToolsEnabled is false', async () => {
    const hook = createToolWhitelistHook(
      makePayload({ mcpToolsEnabled: false, skillsEnabled: true, allowedSkills: ['pdf'] }),
      mockLogger,
    );
    // MCP tool → allowed (mcpToolsEnabled is false)
    const mcpResult = await hook(hookInput('mcp__nanoclawbot__schedule_task'), undefined, opts);
    expect(mcpResult).toEqual({});
    // Skill not in list → denied
    const skillResult = await hook(hookInput('Skill', { skill: 'agent-browser' }), undefined, opts);
    expect(skillResult).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
  });

  // ── Built-in tools pass through ─────────────────────────────────

  it('allows built-in tools (Bash, Read, Write, etc.)', async () => {
    const hook = createToolWhitelistHook(
      makePayload({ mcpToolsEnabled: true, skillsEnabled: true }),
      mockLogger,
    );
    for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch']) {
      const result = await hook(hookInput(tool), undefined, opts);
      expect(result).toEqual({});
    }
  });

  // ── Audit logging ───────────────────────────────────────────────

  it('logs a warning with structured fields on denial', async () => {
    const warn = vi.fn();
    const logger = { ...mockLogger, warn } as unknown as pino.Logger;
    const hook = createToolWhitelistHook(
      makePayload({ mcpToolsEnabled: true, allowedMcpTools: ['send_message'] }),
      logger,
    );

    await hook(hookInput('mcp__nanoclawbot__schedule_task'), undefined, opts);

    expect(warn).toHaveBeenCalledOnce();
    const logObj = warn.mock.calls[0][0];
    expect(logObj).toMatchObject({
      event: 'tool_access_denied',
      botId: 'bot-1',
      userId: 'user-1',
      groupJid: 'tg:123',
      toolType: 'mcp_tool',
      requestedTool: 'schedule_task',
    });
  });

  it('does not log when tool is allowed', async () => {
    const warn = vi.fn();
    const logger = { ...mockLogger, warn } as unknown as pino.Logger;
    const hook = createToolWhitelistHook(
      makePayload({ mcpToolsEnabled: true, allowedMcpTools: ['send_message'] }),
      logger,
    );

    await hook(hookInput('mcp__nanoclawbot__send_message'), undefined, opts);
    expect(warn).not.toHaveBeenCalled();
  });

  // ── Edge cases ──────────────────────────────────────────────────

  it('handles Skill tool with missing skill name', async () => {
    const hook = createToolWhitelistHook(
      makePayload({ skillsEnabled: true, allowedSkills: ['pdf'] }),
      mockLogger,
    );
    const result = await hook(hookInput('Skill', {}), undefined, opts);
    expect(result).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
  });

  it('handles unknown tool names (not MCP, not Skill) — passes through', async () => {
    const hook = createToolWhitelistHook(
      makePayload({ mcpToolsEnabled: true, skillsEnabled: true }),
      mockLogger,
    );
    const result = await hook(hookInput('SomeUnknownTool'), undefined, opts);
    expect(result).toEqual({});
  });
});
