import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InvocationPayload, InvocationResult, Session, SqsInboundPayload, SqsTaskPayload } from '@clawbot/shared';
import type { Message as SQSMessage } from '@aws-sdk/client-sqs';
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
    botClaude: 'user-1/bot-1/CLAUDE.md',
    groupPrefix: 'user-1/bot-1/workspace/tg:123/',
    learnings: 'user-1/bot-1/learnings/',
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

  it('returns error with statusCode when response body is empty', async () => {
    mockSend.mockResolvedValue({
      response: { transformToString: () => Promise.resolve('') },
      statusCode: 500,
    });

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result.status).toBe('error');
    expect(result.error).toContain('empty response');
    expect(result.error).toContain('500');
  });

  it('returns error with statusCode when response.response is undefined', async () => {
    mockSend.mockResolvedValue({
      statusCode: 503,
    });

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result.status).toBe('error');
    expect(result.error).toContain('empty response');
    expect(result.error).toContain('503');
  });

  it('extracts errorMessage from AWS-style error response', async () => {
    mockSend.mockResolvedValue({
      response: {
        transformToString: () => Promise.resolve(JSON.stringify({
          errorType: 'RuntimeError',
          errorMessage: 'Session creation timed out',
        })),
      },
      statusCode: 500,
    });

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result.status).toBe('error');
    expect(result.error).toContain('Session creation timed out');
  });

  it('extracts message from generic error response', async () => {
    mockSend.mockResolvedValue({
      response: {
        transformToString: () => Promise.resolve(JSON.stringify({
          message: 'Internal server error',
        })),
      },
      statusCode: 500,
    });

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result.status).toBe('error');
    expect(result.error).toContain('Internal server error');
  });

  it('includes raw response when no standard error field found', async () => {
    mockSend.mockResolvedValue({
      response: {
        transformToString: () => Promise.resolve(JSON.stringify({ fault: 'unknown' })),
      },
      statusCode: 502,
    });

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result.status).toBe('error');
    expect(result.error).toContain('502');
    expect(result.error).toContain('fault');
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

  it('returns busy_retry when AWS SDK rejects with a 503 RuntimeClientError', async () => {
    const err = Object.assign(
      new Error('Received error (503) from runtime. Please check your CloudWatch logs for more information.'),
      { name: 'RuntimeClientError' },
    );
    mockSend.mockRejectedValue(err);

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result.status).toBe('busy_retry');
    expect(result.result).toBeNull();
    expect(result.error).toContain('503');
  });

  it('returns busy_retry when error message carries the (503) signature even without name', async () => {
    mockSend.mockRejectedValue(new Error('Received error (503) from runtime.'));

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result.status).toBe('busy_retry');
  });

  it('still returns error (not busy_retry) for non-503 RuntimeClientError', async () => {
    const err = Object.assign(
      new Error('Received error (500) from runtime.'),
      { name: 'RuntimeClientError' },
    );
    mockSend.mockRejectedValue(err);

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result.status).toBe('error');
    expect(result.error).toContain('500');
  });
});

// ── Async dispatch tests (fire-and-forget) ──────────────────────────────────

describe('dispatch async invoke handling', () => {
  const mockSendReply = vi.fn();
  const mockEnsureUser = vi.fn();
  const mockCheckAndAcquireAgentSlot = vi.fn();
  const mockReleaseAgentSlot = vi.fn();
  const mockGetGroup = vi.fn();
  const mockGetSession = vi.fn();
  const mockGetTask = vi.fn();
  const mockGetCachedBot = vi.fn();
  const mockSetSessionResetPending = vi.fn();

  let dispatch: (sqsMessage: SQSMessage, logger: Logger) => Promise<{ deleteImmediately?: boolean }>;

  function makeSqsMessage(body: SqsInboundPayload | SqsTaskPayload): SQSMessage {
    return { Body: JSON.stringify(body) } as SQSMessage;
  }

  function mockAgentResult(result: InvocationResult) {
    mockSend.mockResolvedValue({
      response: {
        transformToString: () => Promise.resolve(JSON.stringify({ output: result })),
      },
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    mockSend.mockReset();
    mockSendReply.mockReset();
    mockEnsureUser.mockReset();
    mockCheckAndAcquireAgentSlot.mockReset();
    mockReleaseAgentSlot.mockReset();
    mockGetGroup.mockReset();
    mockGetSession.mockReset();
    mockGetTask.mockReset();
    mockGetCachedBot.mockReset();
    mockSetSessionResetPending.mockReset();
    mockSetSessionResetPending.mockResolvedValue(undefined);
    (mockLogger.info as ReturnType<typeof vi.fn>).mockReset();
    (mockLogger.error as ReturnType<typeof vi.fn>).mockReset();

    // Default mock behaviors
    mockGetCachedBot.mockResolvedValue({ name: 'TestBot', status: 'active', systemPrompt: 'You are a bot', model: 'claude-sonnet' });
    mockEnsureUser.mockResolvedValue({ usageTokens: 0, quota: { maxMonthlyTokens: 100000, maxConcurrentAgents: 2 } });
    mockCheckAndAcquireAgentSlot.mockResolvedValue(true);
    mockReleaseAgentSlot.mockResolvedValue(undefined);
    mockGetGroup.mockResolvedValue({ isGroup: false, channelType: 'telegram' });
    mockGetSession.mockResolvedValue(null);
    mockGetTask.mockResolvedValue({ status: 'active', prompt: 'Run daily check' });

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

    vi.doMock('../services/dynamo.js', () => ({
      getGroup: mockGetGroup,
      getSession: mockGetSession,
      getRecentMessages: vi.fn().mockResolvedValue([]),
      ensureUser: mockEnsureUser,
      getTask: mockGetTask,
      checkAndAcquireAgentSlot: mockCheckAndAcquireAgentSlot,
      releaseAgentSlot: mockReleaseAgentSlot,
      setSessionResetPending: mockSetSessionResetPending,
    }));

    vi.doMock('../services/cached-lookups.js', () => ({
      getCachedBot: mockGetCachedBot,
    }));

    vi.doMock('../adapters/registry.js', () => ({
      getRegistry: () => ({
        get: () => ({ sendReply: mockSendReply }),
      }),
    }));

    const mod = await import('../sqs/dispatcher.js');
    dispatch = mod.dispatch;
  });

  it('does not send channel reply when agent returns accepted', async () => {
    mockAgentResult({ status: 'accepted', result: null });

    const payload: SqsInboundPayload = {
      type: 'inbound_message',
      botId: 'bot-1',
      groupJid: 'tg:123',
      userId: 'user-1',
      messageId: 'msg-1',
      content: 'Hello',
      channelType: 'telegram',
      timestamp: new Date().toISOString(),
    };

    await dispatch(makeSqsMessage(payload), mockLogger);

    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it('sends error reply when agent invocation is rejected', async () => {
    mockAgentResult({ status: 'error', result: null, error: 'AgentCore unreachable' });

    const payload: SqsInboundPayload = {
      type: 'inbound_message',
      botId: 'bot-1',
      groupJid: 'tg:123',
      userId: 'user-1',
      messageId: 'msg-2',
      content: 'Hello',
      channelType: 'telegram',
      timestamp: new Date().toISOString(),
    };

    await dispatch(makeSqsMessage(payload), mockLogger);

    expect(mockSendReply).toHaveBeenCalledOnce();
    expect((mockLogger.error as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('releases agent slot even on invocation failure', async () => {
    mockAgentResult({ status: 'error', result: null, error: 'Something went wrong' });

    const payload: SqsInboundPayload = {
      type: 'inbound_message',
      botId: 'bot-1',
      groupJid: 'tg:123',
      userId: 'user-1',
      messageId: 'msg-3',
      content: 'Hello',
      channelType: 'telegram',
      timestamp: new Date().toISOString(),
    };

    await dispatch(makeSqsMessage(payload), mockLogger);

    expect(mockReleaseAgentSlot).toHaveBeenCalledOnce();
  });

  it('dispatches scheduled task and logs rejection on non-accepted status', async () => {
    mockAgentResult({ status: 'error', result: null, error: 'Runtime down' });

    const payload: SqsTaskPayload = {
      type: 'scheduled_task',
      botId: 'bot-1',
      groupJid: 'tg:123',
      userId: 'user-1',
      taskId: 'task-1',
      timestamp: new Date().toISOString(),
    };

    await dispatch(makeSqsMessage(payload), mockLogger);

    expect((mockLogger.error as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  // ── Slash command interception ─────────────────────────────────────────────

  function slashPayload(content: string): SqsInboundPayload {
    return {
      type: 'inbound_message',
      botId: 'bot-1',
      groupJid: 'tg:123',
      userId: 'user-1',
      messageId: 'msg-slash',
      content,
      channelType: 'telegram',
      timestamp: new Date().toISOString(),
    };
  }

  it.each(['/clear', '/reset', '/new'])(
    '%s: queues session reset, replies, and signals immediate SQS delete',
    async (cmd) => {
      const result = await dispatch(makeSqsMessage(slashPayload(cmd)), mockLogger);

      expect(result.deleteImmediately).toBe(true);
      expect(mockSetSessionResetPending).toHaveBeenCalledWith('bot-1', 'tg:123', true);
      expect(mockSendReply).toHaveBeenCalledOnce();
      expect(mockSendReply.mock.calls[0][1]).toBe('会话已重置');

      // No quota / slot / agent invocation for dispatcher-handled commands
      expect(mockEnsureUser).not.toHaveBeenCalled();
      expect(mockCheckAndAcquireAgentSlot).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    },
  );

  it('/help: replies with command list and signals immediate SQS delete', async () => {
    const result = await dispatch(makeSqsMessage(slashPayload('/help')), mockLogger);

    expect(result.deleteImmediately).toBe(true);
    expect(mockSendReply).toHaveBeenCalledOnce();
    expect(mockSendReply.mock.calls[0][1]).toContain('/clear');
    expect(mockSendReply.mock.calls[0][1]).toContain('/compact');
    expect(mockSetSessionResetPending).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('/foobar: replies with unsupported notice, does not invoke agent or set reset', async () => {
    await dispatch(makeSqsMessage(slashPayload('/foobar')), mockLogger);

    expect(mockSendReply).toHaveBeenCalledOnce();
    expect(mockSendReply.mock.calls[0][1]).toBe('不支持的命令: /foobar');
    expect(mockSetSessionResetPending).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('/tmp/foo.log: path-like input reaches the agent as a normal prompt', async () => {
    mockAgentResult({ status: 'accepted', result: null });

    await dispatch(makeSqsMessage(slashPayload('/tmp/foo.log please inspect')), mockLogger);

    // Normal flow — quota/slot/agent all invoked; no reset queued, no unsupported reply
    expect(mockEnsureUser).toHaveBeenCalled();
    expect(mockCheckAndAcquireAgentSlot).toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSetSessionResetPending).not.toHaveBeenCalled();
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it('/compact: passes through with sdkCommand set and no group context', async () => {
    mockAgentResult({ status: 'accepted', result: null });

    await dispatch(makeSqsMessage(slashPayload('/compact')), mockLogger);

    expect(mockSend).toHaveBeenCalledOnce();
    const command = mockSend.mock.calls[0][0];
    const sent = JSON.parse(Buffer.from(command.payload).toString()) as InvocationPayload;
    expect(sent.sdkCommand).toBe('compact');
    // Prompt is the raw command — no group-chat context prepended for SDK slash commands
    expect(sent.prompt).toBe('/compact');
  });

  it('/context: passes through with sdkCommand=context', async () => {
    mockAgentResult({ status: 'accepted', result: null });

    await dispatch(makeSqsMessage(slashPayload('/context')), mockLogger);

    const command = mockSend.mock.calls[0][0];
    const sent = JSON.parse(Buffer.from(command.payload).toString()) as InvocationPayload;
    expect(sent.sdkCommand).toBe('context');
  });
});

// ── shouldResetSession unit tests ───────────────────────────────────────────

describe('shouldResetSession', () => {
  // Import directly — this is a pure function with no side effects
  let shouldResetSession: typeof import('../sqs/dispatcher.js').shouldResetSession;

  beforeEach(async () => {
    vi.resetModules();

    // Minimal mocks so the module can load
    vi.doMock('@aws-sdk/client-bedrock-agentcore', () => ({
      BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({})),
      InvokeAgentRuntimeCommand: vi.fn(),
    }));
    vi.doMock('../config.js', () => ({ config: { region: 'us-east-1', agentcore: {} } }));
    vi.doMock('../services/dynamo.js', () => ({}));
    vi.doMock('../services/secrets.js', () => ({}));
    vi.doMock('../services/cached-lookups.js', () => ({}));
    vi.doMock('../adapters/registry.js', () => ({}));

    const mod = await import('../sqs/dispatcher.js');
    shouldResetSession = mod.shouldResetSession;
  });

  const baseSession: Session = {
    botId: 'bot-1',
    groupJid: 'tg:123',
    agentcoreSessionId: 'sess-1',
    s3SessionPath: 'path/',
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    lastModel: 'claude-sonnet',
    lastModelProvider: 'bedrock',
  };

  it('returns false when session is null (first invocation)', () => {
    expect(shouldResetSession(null, 'claude-sonnet', 'bedrock')).toBe(false);
  });

  it('returns false for legacy session without lastModel/lastModelProvider', () => {
    const legacy: Session = { ...baseSession, lastModel: undefined, lastModelProvider: undefined };
    expect(shouldResetSession(legacy, 'claude-sonnet', 'bedrock')).toBe(false);
  });

  it('returns false when model and provider match', () => {
    expect(shouldResetSession(baseSession, 'claude-sonnet', 'bedrock')).toBe(false);
  });

  it('returns true when model changed', () => {
    expect(shouldResetSession(baseSession, 'minimax-m2.5', 'bedrock')).toBe(true);
  });

  it('returns true when provider changed', () => {
    expect(shouldResetSession(baseSession, 'claude-sonnet', 'anthropic-api')).toBe(true);
  });

  it('returns true when both changed', () => {
    expect(shouldResetSession(baseSession, 'minimax-m2.5', 'anthropic-api')).toBe(true);
  });

  it('returns true when model becomes undefined', () => {
    expect(shouldResetSession(baseSession, undefined, 'bedrock')).toBe(true);
  });

  it('returns true when provider becomes undefined', () => {
    expect(shouldResetSession(baseSession, 'claude-sonnet', undefined)).toBe(true);
  });

  it('returns true when resetPending is set (from /clear) even if model/provider match', () => {
    const resetSession: Session = { ...baseSession, resetPending: true };
    expect(shouldResetSession(resetSession, 'claude-sonnet', 'bedrock')).toBe(true);
  });

  it('returns false when resetPending is false and model/provider match', () => {
    const session: Session = { ...baseSession, resetPending: false };
    expect(shouldResetSession(session, 'claude-sonnet', 'bedrock')).toBe(false);
  });

  it('returns true when resetPending is set on a session with no prior model (first /clear)', () => {
    // Locks in the ordering at dispatcher.ts: the resetPending check must
    // short-circuit BEFORE the `!lastModel && !lastModelProvider` guard,
    // so that /clear works on a fresh session that has no model recorded yet.
    const fresh: Session = {
      ...baseSession,
      lastModel: undefined,
      lastModelProvider: undefined,
      resetPending: true,
    };
    expect(shouldResetSession(fresh, 'claude-sonnet', 'bedrock')).toBe(true);
  });
});
