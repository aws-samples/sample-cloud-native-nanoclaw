import {
  query,
  type McpServerStatus,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type pino from 'pino';

const DEFAULT_CONNECTION_TIMEOUT_MS = 120_000;
const MAX_RECONNECT_ATTEMPTS = 2;
const POLL_INTERVAL_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for the SDK's background connections without racing a pending connect. */
async function waitForConnections(
  agent: Query,
  connectionTimeoutMs: number,
): Promise<McpServerStatus[]> {
  // Allow one poll after the SDK's connection deadline to observe its failure.
  const deadline = Date.now() + connectionTimeoutMs + POLL_INTERVAL_MS;
  let servers = await agent.mcpServerStatus();
  while (servers.some((server) => server.status === 'pending') && Date.now() < deadline) {
    await delay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
    servers = await agent.mcpServerStatus();
  }
  return servers;
}

/**
 * Recover MCP startup failures in the same SDK session before submitting any
 * user input. Never retry the agent turn: it may send messages or create tasks.
 */
export async function* queryWithMcpRecovery(
  params: Omit<Parameters<typeof query>[0], 'prompt'> & { prompt: string },
  logger: pino.Logger,
) {
  const env = { ...process.env, ...params.options?.env };
  env.MCP_TIMEOUT ||= String(DEFAULT_CONNECTION_TIMEOUT_MS);
  const configuredTimeout = Number(env.MCP_TIMEOUT);
  const connectionTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_CONNECTION_TIMEOUT_MS;
  env.MCP_TIMEOUT = String(connectionTimeoutMs);

  let releasePrompt!: (send: boolean) => void;
  const ready = new Promise<boolean>((resolve) => { releasePrompt = resolve; });
  async function* input(): AsyncGenerator<SDKUserMessage> {
    if (await ready) {
      yield {
        type: 'user',
        message: { role: 'user', content: params.prompt },
        parent_tool_use_id: null,
        session_id: '',
      };
    }
  }

  const agent = query({
    ...params,
    prompt: input(),
    options: { ...params.options, env },
  });
  try {
    let servers = await waitForConnections(agent, connectionTimeoutMs);
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      const failed = servers.filter((server) => server.status === 'failed');
      if (!failed.length) break;

      await delay(attempt * POLL_INTERVAL_MS);
      await Promise.all(failed.map(async (server) => {
        logger.warn(
          { server: server.name, attempt, error: server.error },
          'Retrying MCP server connection',
        );
        try {
          await agent.reconnectMcpServer(server.name);
        } catch (err) {
          logger.warn({ server: server.name, attempt, err }, 'MCP server reconnect failed');
        }
      }));
      servers = await waitForConnections(agent, connectionTimeoutMs);
    }

    for (const server of servers) {
      if (server.status !== 'connected') {
        logger.warn(
          { server: server.name, status: server.status, error: server.error },
          'MCP server unavailable after startup recovery',
        );
      }
    }
    const required = servers.find((server) => server.name === 'nanoclawbot');
    if (required?.status !== 'connected') {
      throw new Error(
        `Required MCP server nanoclawbot is unavailable after startup recovery: ${
          required?.error || required?.status || 'missing'
        }`,
      );
    }

    logger.info(
      { servers: servers.filter((server) => server.status === 'connected').map((server) => server.name) },
      'MCP startup recovery complete',
    );
    releasePrompt(true);
    yield* agent;
  } finally {
    // Unblock the input generator on failure without submitting the prompt.
    releasePrompt(false);
    agent.close();
  }
}
