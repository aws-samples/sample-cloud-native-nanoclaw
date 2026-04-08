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
import { sendFinalReply, sendErrorReply } from './mcp-tools.js';
import type { InvocationPayload } from '@clawbot/shared';
import { formatOutbound } from '@clawbot/shared/text-utils';

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

// Agent execution endpoint — async fire-and-forget
app.post<{ Body: InvocationPayload }>('/invocations', async (request, reply) => {
  const payload = request.body;
  logger.info({ botId: payload.botId, groupJid: payload.groupJid }, 'Invocation received');

  setBusy();

  // Fire-and-forget: run in background, respond immediately
  runInBackground(payload).catch((err) => {
    logger.error(err, 'Background invocation crashed unexpectedly');
  });

  return reply.send({ status: 'accepted' });
});

async function runInBackground(payload: InvocationPayload): Promise<void> {
  try {
    const result = await handleInvocation(payload, logger);

    if (result.status === 'success' && result.result) {
      const text = result.result.trim();
      if (text !== 'NO_REPLY') {
        await sendFinalReply(payload, {
          ...result,
          result: formatOutbound(result.result),
        });
      }
    } else if (result.status === 'error') {
      await sendErrorReply(payload, new Error(result.error || 'Unknown agent error')).catch((e) => {
        logger.error(e, 'Failed to send error notification');
      });
    }
  } catch (error) {
    logger.error(error, 'Background invocation failed');
    await sendErrorReply(payload, error).catch((e) => {
      logger.error(e, 'Failed to send error notification');
    });
  } finally {
    setIdle();
  }
}

app.listen({ port, host: '0.0.0.0' }).then(() => {
  logger.info(`Agent runtime listening on port ${port}`);
});
