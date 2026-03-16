import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InvocationPayload, InvocationResult } from '@clawbot/shared';
import type { Logger } from 'pino';

// Mock the AWS SDK client
const mockSend = vi.fn();
vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  InvokeAgentRuntimeCommand: vi.fn().mockImplementation((input: unknown) => input),
}));

// Stub config before importing the module under test
vi.mock('../config.js', () => ({
  config: {
    region: 'us-east-1',
    agentcore: {
      runtimeArn: 'arn:aws:bedrock:us-east-1:123456789012:agent-runtime/test-runtime',
    },
  },
}));

const mockLogger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const basePayload: InvocationPayload = {
  botId: 'bot-1',
  botName: 'TestBot',
  groupJid: 'tg:123',
  userId: 'user-1',
  channelType: 'telegram',
  prompt: 'Hello agent',
  systemPrompt: 'You are a test bot',
  sessionPath: 'user-1/bot-1/sessions/tg:123/',
  memoryPaths: {
    shared: 'user-1/shared/CLAUDE.md',
    botGlobal: 'user-1/bot-1/memory/global/CLAUDE.md',
    group: 'user-1/bot-1/memory/tg:123/CLAUDE.md',
  },
};

describe('invokeAgent', () => {
  let invokeAgent: (payload: InvocationPayload, logger: Logger) => Promise<InvocationResult>;

  beforeEach(async () => {
    vi.resetModules();
    mockSend.mockReset();

    // Re-mock SDK after resetModules
    vi.doMock('@aws-sdk/client-bedrock-agentcore', () => ({
      BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
      InvokeAgentRuntimeCommand: vi.fn().mockImplementation((input: unknown) => input),
    }));

    vi.doMock('../config.js', () => ({
      config: {
        region: 'us-east-1',
        agentcore: {
          runtimeArn: 'arn:aws:bedrock:us-east-1:123456789012:agent-runtime/test-runtime',
        },
      },
    }));

    const mod = await import('../sqs/dispatcher.js');
    invokeAgent = mod.invokeAgent;
  });

  it('returns parsed output on successful invocation', async () => {
    const expected: InvocationResult = {
      status: 'success',
      result: 'Hello from agent',
      newSessionId: 'sess-42',
      tokensUsed: 1500,
    };

    mockSend.mockResolvedValue({
      response: {
        transformToString: () => Promise.resolve(JSON.stringify({ output: expected })),
      },
      runtimeSessionId: 'bot-1---tg:123',
    });

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result).toEqual(expected);
    expect(mockSend).toHaveBeenCalledOnce();

    const command = mockSend.mock.calls[0][0];
    expect(command.agentRuntimeArn).toBe(
      'arn:aws:bedrock:us-east-1:123456789012:agent-runtime/test-runtime',
    );
    expect(command.contentType).toBe('application/json');
    expect(command.runtimeSessionId).toBe('bot-1---tg:123');
    expect(JSON.parse(Buffer.from(command.payload).toString())).toEqual(basePayload);
  });

  it('returns error result on SDK failure without throwing', async () => {
    mockSend.mockRejectedValue(new Error('Service Unavailable'));

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result.status).toBe('error');
    expect(result.result).toBeNull();
    expect(result.error).toContain('Service Unavailable');
  });

  it('returns error result on network failure without throwing', async () => {
    mockSend.mockRejectedValue(new Error('Connection refused'));

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result.status).toBe('error');
    expect(result.result).toBeNull();
    expect(result.error).toContain('Connection refused');
  });

  it('returns error when runtime ARN is not configured', async () => {
    vi.doMock('../config.js', () => ({
      config: {
        region: 'us-east-1',
        agentcore: {
          runtimeArn: '',
        },
      },
    }));
    vi.resetModules();

    vi.doMock('@aws-sdk/client-bedrock-agentcore', () => ({
      BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
      InvokeAgentRuntimeCommand: vi.fn().mockImplementation((input: unknown) => input),
    }));

    const mod = await import('../sqs/dispatcher.js');
    const invokeAgentNoConfig = mod.invokeAgent;

    mockSend.mockReset();

    const result = await invokeAgentNoConfig(basePayload, mockLogger);

    expect(result.status).toBe('error');
    expect(result.result).toBeNull();
    expect(result.error).toContain('not configured');
    expect(mockSend).not.toHaveBeenCalled();
  });
});
