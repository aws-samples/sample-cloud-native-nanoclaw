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
import { registerTask } from './task-registration.js';
import { startIdleMonitor, resetIdleTimer, pauseIdleTimer } from './idle-monitor.js';
import type { InvocationPayload } from '@clawbot/shared';
import { formatOutbound } from '@clawbot/shared/text-utils';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
});
const port = Number(process.env.PORT) || 8080;

const app = Fastify({ loggerInstance: logger });

// Busy state tracking — reflects whether the agent is currently processing
let busy = false;
export function setBusy() { busy = true; }
export function setIdle() { busy = false; }

// Idle monitor is deferred until the first /invocations — that is the moment
// this container stops being a "warm pool" member and becomes a dedicated,
// session-bound task. Tracked with a flag so we only start the monitor once.
let idleMonitorStarted = false;
function ensureIdleMonitorStarted() {
  if (idleMonitorStarted) return;
  if (process.env.AGENT_MODE !== 'ecs') return;
  const idleMinutes = Number(process.env.IDLE_TIMEOUT_MINUTES) || 60;
  startIdleMonitor(logger, idleMinutes, async () => {
    logger.info('Idle timeout — performing graceful shutdown');
  });
  idleMonitorStarted = true;
  logger.info({ idleMinutes }, 'Idle monitor activated (task transitioned warm -> dedicated)');
}

// AgentCore health check — must never block, respond in < 100ms
app.get('/ping', async () => {
  return { status: busy ? 'HealthyBusy' : 'Healthy' };
});

// Agent execution endpoint — async fire-and-forget
app.post<{ Body: InvocationPayload }>('/invocations', async (request, reply) => {
  const payload = request.body;
  ensureIdleMonitorStarted();
  // Reject concurrent requests — single-concurrency per task in both modes.
  // SQS FIFO + deferred deletion prevents this in normal operation, but
  // 503 rejection is a safety net against edge cases (CP restart, receipt expiry).
  if (busy) {
    logger.info({ botId: payload.botId, groupJid: payload.groupJid }, 'Agent busy, rejecting request');
    return reply.status(503).send({ error: 'Agent is busy' });
  }

  logger.info({ botId: payload.botId, groupJid: payload.groupJid }, 'Invocation received');
  setBusy();

  // Pause idle timer while busy — prevents long-running invocations (>15 min)
  // from being killed mid-execution. Timer restarts in runInBackground's finally block.
  if (process.env.AGENT_MODE === 'ecs') pauseIdleTimer();

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
      } else {
        // NO_REPLY: still send completion signal so SQS FIFO unblocks same-group queue
        await sendFinalReply(payload, { ...result, result: null });
      }
    } else if (result.status === 'error') {
      await sendErrorReply(payload, new Error(result.error || 'Unknown agent error')).catch((e) => {
        logger.error(e, 'Failed to send error notification');
      });
    } else {
      // Success with null/empty result: send completion signal to unblock queue
      await sendFinalReply(payload, { ...result, result: null });
    }
  } catch (error) {
    logger.error(error, 'Background invocation failed');
    await sendErrorReply(payload, error).catch((e) => {
      logger.error(e, 'Failed to send error notification');
    });
  } finally {
    setIdle();
    // Reset idle timer AFTER invocation completes, not when request arrives.
    // The timer at request time (line 53) prevents timeout during execution;
    // this reset starts the real idle countdown from completion.
    if (process.env.AGENT_MODE === 'ecs') resetIdleTimer();
  }
}

await app.listen({ port, host: '0.0.0.0' });
logger.info(`Agent runtime listening on port ${port}`);

// ECS dedicated task mode — register as warm. Idle monitor is deferred
// to the first /invocations (see above) so warm tasks do NOT exit and
// force the control-plane warm-pool replenisher into a ~$$$/day cold-start loop.
if (process.env.AGENT_MODE === 'ecs') {
  try {
    const meta = await registerTask(logger);
    logger.info({ taskArn: meta.taskArn }, 'ECS task registered');
  } catch (err) {
    logger.error(err, 'Failed to register ECS task');
  }
}
