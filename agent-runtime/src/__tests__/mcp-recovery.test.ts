import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query, type McpServerStatus, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';
import { queryWithMcpRecovery } from '../mcp-recovery.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

const logger = pino({ level: 'silent' });
const connected: McpServerStatus = { name: 'nanoclawbot', status: 'connected' };
const failed: McpServerStatus = {
  name: 'nanoclawbot',
  status: 'failed',
  error: 'connection timed out after 30000ms',
};

function mockAgent(statuses: McpServerStatus[]) {
  const submitted: SDKUserMessage[] = [];
  const status = vi.fn().mockResolvedValue(statuses);
  const reconnect = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  vi.mocked(query).mockImplementation((params) => {
    // The SDK starts consuming streaming input as soon as query() is called.
    const firstInput = (params.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next()
      .then((input) => {
        if (!input.done) submitted.push(input.value);
        return input;
      });
    return {
      mcpServerStatus: status,
      reconnectMcpServer: reconnect,
      close,
      async *[Symbol.asyncIterator]() {
        const input = await firstInput;
        if (!input.done) yield { type: 'result', subtype: 'success', result: 'done' };
      },
    } as unknown as Query;
  });
  return { status, reconnect, close, submitted };
}

async function run(env: Record<string, string> = {}) {
  // Attach the error handler before advancing timers to avoid unhandled rejects.
  const outcome = (async () => {
    const messages = [];
    for await (const message of queryWithMcpRecovery({
      prompt: 'Run the daily scheduled task',
      options: { env: { MCP_TIMEOUT: '1000', ...env } },
    }, logger)) messages.push(message);
    return messages;
  })().then(
    (messages) => ({ messages, error: undefined }),
    (error: Error) => ({ messages: [], error }),
  );
  await vi.runAllTimersAsync();
  return outcome;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('MCP startup recovery', () => {
  it('submits the prompt once when the required server is connected', async () => {
    const agent = mockAgent([connected]);
    const result = await run();
    expect(result.error).toBeUndefined();
    expect(result.messages).toHaveLength(1);
    expect(agent.submitted.map((input) => input.message.content)).toEqual(['Run the daily scheduled task']);
    expect(agent.reconnect).not.toHaveBeenCalled();
    expect(agent.close).toHaveBeenCalledOnce();
  });

  it('waits for pending startup and reconnects a timeout before submitting input', async () => {
    const agent = mockAgent([connected]);
    agent.status
      .mockResolvedValueOnce([{ name: 'nanoclawbot', status: 'pending' }])
      .mockResolvedValueOnce([failed]);
    agent.reconnect.mockImplementation(async () => {
      expect(agent.submitted).toEqual([]);
    });
    const result = await run();
    expect(result.error).toBeUndefined();
    expect(agent.reconnect).toHaveBeenCalledExactlyOnceWith('nanoclawbot');
    expect(agent.submitted).toHaveLength(1);
  });

  it('retries a rejected reconnect and recovers within the same session', async () => {
    const agent = mockAgent([failed]);
    agent.reconnect
      .mockRejectedValueOnce(new Error('connection timed out'))
      .mockImplementationOnce(async () => { agent.status.mockResolvedValue([connected]); });
    const result = await run();
    expect(result.error).toBeUndefined();
    expect(agent.reconnect).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledOnce();
    expect(agent.submitted).toHaveLength(1);
  });

  it('fails after bounded retries without submitting a task that lacks core tools', async () => {
    const agent = mockAgent([failed]);
    const result = await run();
    expect(result.error?.message).toContain('Required MCP server nanoclawbot is unavailable');
    expect(agent.reconnect).toHaveBeenCalledTimes(2);
    expect(agent.submitted).toEqual([]);
    expect(agent.close).toHaveBeenCalledOnce();
  });

  it('continues with core tools when an optional server remains unavailable', async () => {
    const agent = mockAgent([connected, { name: 'kiro-web-search', status: 'failed' }]);
    const result = await run();
    expect(result.error).toBeUndefined();
    expect(agent.reconnect.mock.calls).toEqual([['kiro-web-search'], ['kiro-web-search']]);
    expect(agent.submitted).toHaveLength(1);
  });

  it('recovers optional servers too', async () => {
    const agent = mockAgent([connected, { name: 'kiro-web-search', status: 'failed' }]);
    agent.reconnect.mockImplementation(async () => { agent.status.mockResolvedValue([connected, { name: 'kiro-web-search', status: 'connected' }]); });
    const result = await run();
    expect(result.error).toBeUndefined();
    expect(agent.reconnect).toHaveBeenCalledExactlyOnceWith('kiro-web-search');
  });

  it.each(['needs-auth', 'disabled'] as const)('does not retry a server that is %s', async (status) => {
    const agent = mockAgent([connected, { name: 'optional', status }]);
    const result = await run();
    expect(result.error).toBeUndefined();
    expect(agent.reconnect).not.toHaveBeenCalled();
  });

  it('bounds the wait for a server that never leaves pending', async () => {
    const agent = mockAgent([{ name: 'nanoclawbot', status: 'pending' }]);
    const result = await run();
    expect(result.error?.message).toContain('pending');
    expect(agent.reconnect).not.toHaveBeenCalled();
    expect(agent.submitted).toEqual([]);
    expect(agent.close).toHaveBeenCalledOnce();
  });

  it('fails explicitly when the required server is missing', async () => {
    const agent = mockAgent([]);
    const result = await run();
    expect(result.error?.message).toContain('missing');
    expect(agent.submitted).toEqual([]);
  });

  it('closes the SDK session when status inspection throws', async () => {
    const agent = mockAgent([connected]);
    agent.status.mockRejectedValue(new Error('SDK process exited'));
    const result = await run();
    expect(result.error?.message).toBe('SDK process exited');
    expect(agent.submitted).toEqual([]);
    expect(agent.close).toHaveBeenCalledOnce();
  });

  it('does not replay the agent turn if execution fails after startup', async () => {
    const agent = mockAgent([connected]);
    vi.mocked(query).mockImplementationOnce((params) => ({
      mcpServerStatus: agent.status,
      reconnectMcpServer: agent.reconnect,
      close: agent.close,
      async *[Symbol.asyncIterator]() {
        for await (const input of params.prompt as AsyncIterable<SDKUserMessage>) {
          agent.submitted.push(input);
          throw new Error('execution failed after sending a message');
        }
      },
    }) as unknown as Query);
    const result = await run();
    expect(result.error?.message).toContain('execution failed');
    expect(query).toHaveBeenCalledOnce();
    expect(agent.submitted).toHaveLength(1);
    expect(agent.reconnect).not.toHaveBeenCalled();
    expect(agent.close).toHaveBeenCalledOnce();
  });

  it('uses a longer startup timeout by default and preserves other SDK environment', async () => {
    mockAgent([connected]);
    vi.stubEnv('MCP_TIMEOUT', '');
    await run({ MCP_TIMEOUT: '', ANTHROPIC_API_KEY: 'test-key' });
    expect(vi.mocked(query).mock.calls[0][0].options?.env).toMatchObject({
      MCP_TIMEOUT: '120000',
      ANTHROPIC_API_KEY: 'test-key',
    });
  });

  it('respects a configured connection timeout', async () => {
    mockAgent([connected]);
    await run({ MCP_TIMEOUT: '45000' });
    expect(vi.mocked(query).mock.calls[0][0].options?.env?.MCP_TIMEOUT).toBe('45000');
  });
});
