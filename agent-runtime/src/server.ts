/**
 * ClawBot Cloud — Agent Runtime HTTP Server
 *
 * Runs inside AgentCore microVMs.  Exposes two endpoints:
 *   GET  /ping         — health check (must respond < 100ms)
 *   POST /invocations  — agent execution (long-running, streams result)
 *
 * Cloud equivalent of NanoClaw's container entrypoint that reads stdin JSON.
 */

import Fastify from 'fastify';
import pino from 'pino';
import { handleInvocation } from './agent.js';
import type { InvocationPayload, InvocationResult } from '@clawbot/shared';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const port = Number(process.env.PORT) || 8080;

const app = Fastify({ loggerInstance: logger });

// Busy state tracking — reflects whether the agent is currently processing
let busy = false;
export function setBusy() { busy = true; }
export function setIdle() { busy = false; }

// AgentCore health check — must never block, respond in < 100ms
app.get('/ping', async () => {
  return { status: busy ? 'HealthyBusy' : 'Healthy' };
});

// Agent execution endpoint
app.post<{ Body: InvocationPayload }>('/invocations', async (request, reply) => {
  const payload = request.body;
  logger.info({ botId: payload.botId, groupJid: payload.groupJid }, 'Invocation received');

  try {
    const result = await handleInvocation(payload, logger);
    return reply.send(result);
  } catch (error) {
    logger.error(error, 'Invocation failed');
    // Include env diagnostics in error response for ABAC debugging
    const envDebug = `SCOPED_ROLE_ARN=${process.env.SCOPED_ROLE_ARN || '(empty)'}, SESSION_BUCKET=${process.env.SESSION_BUCKET || '(empty)'}, AWS_REGION=${process.env.AWS_REGION || '(empty)'}`;
    const result: InvocationResult = {
      status: 'error',
      result: null,
      error: `${error instanceof Error ? error.message : 'Unknown error'} [ENV: ${envDebug}] [userId=${payload.userId}, botId=${payload.botId}]`,
    };
    // 200 even on agent error — AgentCore contract treats HTTP errors as infra failures
    return reply.status(200).send(result);
  }
});

app.listen({ port, host: '0.0.0.0' }).then(() => {
  logger.info(`Agent runtime listening on port ${port}`);
});
