// ClawBot Cloud — Memory Management API Routes
// CRUD for CLAUDE.md memory files at shared, bot-global, and group levels

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { config } from '../../config.js';
import { getBot } from '../../services/dynamo.js';

const s3 = new S3Client({ region: config.region });

const putMemorySchema = z.object({
  content: z.string().max(102400), // 100KB max
});

/** Read an S3 object as text; return empty string if the key does not exist. */
async function readMemory(key: string): Promise<string> {
  try {
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: config.s3Bucket,
        Key: key,
      }),
    );
    return (await res.Body?.transformToString()) ?? '';
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'NoSuchKey') {
      return '';
    }
    throw err;
  }
}

/** Write text to an S3 object with markdown content type. */
async function writeMemory(key: string, content: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
      Body: content,
      ContentType: 'text/markdown',
    }),
  );
}

export const memoryRoutes: FastifyPluginAsync = async (app) => {
  // ── Shared memory (user-wide) ───────────────────────────────────────────

  app.get('/shared-memory', async (request) => {
    const key = `${request.userId}/shared/CLAUDE.md`;
    const content = await readMemory(key);
    return { content };
  });

  app.put('/shared-memory', async (request) => {
    const { content } = putMemorySchema.parse(request.body);
    const key = `${request.userId}/shared/CLAUDE.md`;
    await writeMemory(key, content);
    return { content };
  });

  // ── Bot-global memory ───────────────────────────────────────────────────

  app.get<{ Params: { botId: string } }>(
    '/bots/:botId/memory',
    async (request, reply) => {
      const { botId } = request.params;
      const bot = await getBot(request.userId, botId);
      if (!bot) {
        return reply.status(404).send({ error: 'Bot not found' });
      }
      const key = `${request.userId}/${botId}/CLAUDE.md`;
      const content = await readMemory(key);
      return { content };
    },
  );

  app.put<{ Params: { botId: string } }>(
    '/bots/:botId/memory',
    async (request, reply) => {
      const { botId } = request.params;
      const bot = await getBot(request.userId, botId);
      if (!bot) {
        return reply.status(404).send({ error: 'Bot not found' });
      }
      const { content } = putMemorySchema.parse(request.body);
      const key = `${request.userId}/${botId}/CLAUDE.md`;
      await writeMemory(key, content);
      return { content };
    },
  );

  // ── Group-specific memory ───────────────────────────────────────────────

  app.get<{ Params: { botId: string; groupJid: string } }>(
    '/bots/:botId/groups/:groupJid/memory',
    async (request, reply) => {
      const { botId, groupJid } = request.params;
      const bot = await getBot(request.userId, botId);
      if (!bot) {
        return reply.status(404).send({ error: 'Bot not found' });
      }
      const key = `${request.userId}/${botId}/workspace/${groupJid}/CLAUDE.md`;
      const content = await readMemory(key);
      return { content };
    },
  );

  app.put<{ Params: { botId: string; groupJid: string } }>(
    '/bots/:botId/groups/:groupJid/memory',
    async (request, reply) => {
      const { botId, groupJid } = request.params;
      const bot = await getBot(request.userId, botId);
      if (!bot) {
        return reply.status(404).send({ error: 'Bot not found' });
      }
      const { content } = putMemorySchema.parse(request.body);
      const key = `${request.userId}/${botId}/workspace/${groupJid}/CLAUDE.md`;
      await writeMemory(key, content);
      return { content };
    },
  );

};
