// ClawBot Cloud — Control Plane Entry Point
// Main Fastify application: webhooks, API routes, SQS consumers

import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import pino from 'pino';
import { config, resolveConfig } from './config.js';
import { healthRoutes } from './routes/health.js';
import { apiRoutes } from './routes/api/index.js';
import { webhookRoutes } from './webhooks/index.js';
import { startSqsConsumer, stopSqsConsumer } from './sqs/consumer.js';
import { startReplyConsumer, stopReplyConsumer } from './sqs/reply-consumer.js';
import { startTaskManager, stopTaskManager } from './sqs/task-manager.js';
import { startHealthCheckLoop, stopHealthCheckLoop } from './services/health-checker.js';
import { initRegistry } from './adapters/registry.js';
import { DiscordAdapter } from './adapters/discord/index.js';
import { SlackAdapter } from './adapters/slack/index.js';
import { TelegramAdapter } from './adapters/telegram/index.js';
import { FeishuAdapter } from './adapters/feishu/index.js';
import { DingTalkAdapter } from './adapters/dingtalk/index.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
});

async function main() {
  await resolveConfig();

  const app = Fastify({ loggerInstance: logger });

  await app.register(cors, { origin: config.corsOrigin });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max for skill zips
  await app.register(websocket);

  // SEC-C05: Reject requests not coming through CloudFront (X-Origin-Verify header check).
  // The /health endpoint is exempt because ALB health checks go directly to the container.
  if (config.originVerifySecret) {
    const expectedBuf = Buffer.from(config.originVerifySecret);
    app.addHook('onRequest', async (request, reply) => {
      if (request.url === '/health') return; // ALB health check — no CloudFront
      const header = request.headers['x-origin-verify'];
      if (typeof header !== 'string' || header.length !== expectedBuf.length ||
          !timingSafeEqual(Buffer.from(header), expectedBuf)) {
        return reply.status(403).send({ error: 'Forbidden' });
      }
    });
  }

  await app.register(healthRoutes);
  await app.register(webhookRoutes, { prefix: '/webhook' });
  await app.register(apiRoutes, { prefix: '/api' });

  // ECS mode: proxy /auth/* requests to internal auth-service ALB
  if (config.agentMode === 'ecs' && config.auth.endpoint) {
    app.register(async (authProxy) => {
      // Proxy all /auth/* requests to internal auth-service
      authProxy.all('/*', async (request, reply) => {
        // request.url is the full original URL (e.g. /auth/login), forward as-is
        const targetUrl = `${config.auth.endpoint}${request.url}`;
        const headers: Record<string, string> = {};
        if (request.headers['content-type']) {
          headers['content-type'] = request.headers['content-type'] as string;
        }
        if (request.headers.authorization) {
          headers.authorization = request.headers.authorization;
        }
        if (request.headers['x-bootstrap-secret']) {
          headers['x-bootstrap-secret'] = request.headers['x-bootstrap-secret'] as string;
        }
        try {
          const res = await fetch(targetUrl, {
            method: request.method,
            headers,
            body: request.method !== 'GET' && request.method !== 'HEAD' ? JSON.stringify(request.body) : undefined,
            signal: AbortSignal.timeout(10_000),
          });
          const body = await res.text();
          return reply.status(res.status).header('content-type', res.headers.get('content-type') || 'application/json').send(body);
        } catch (err) {
          logger.error({ err, targetUrl }, 'Auth proxy failed');
          return reply.status(502).send({ error: 'Auth service unavailable' });
        }
      });
    }, { prefix: '/auth' });
    logger.info({ authEndpoint: config.auth.endpoint }, 'Auth proxy enabled for /auth/*');
  }

  // Start background SQS consumers
  startSqsConsumer(logger);
  startTaskManager(logger);
  startReplyConsumer(logger);

  // Start periodic channel health checks
  startHealthCheckLoop(logger);

  // Start channel adapters (Discord Gateway, etc.)
  const registry = initRegistry(logger);
  registry.register(new DiscordAdapter(logger));
  registry.register(new SlackAdapter(logger));
  registry.register(new TelegramAdapter(logger));
  registry.register(new FeishuAdapter(logger));
  registry.register(new DingTalkAdapter(logger));
  registry.startAll().catch((err) => {
    logger.error(err, 'Failed to start channel adapters');
  });

  // Graceful shutdown — release leader locks, drain in-flight SQS messages
  const shutdown = async () => {
    logger.info('Shutting down...');
    stopReplyConsumer();
    stopHealthCheckLoop();
    // Stop adapters first (releases Feishu leader lock, disconnects gateways)
    await registry.stopAll();
    // Stop task manager before draining SQS consumer
    stopTaskManager();
    // Drain SQS consumer: wait for in-flight dispatches, release stuck messages
    await stopSqsConsumer();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info(`Control plane listening on port ${config.port}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
