// ClawBot Cloud — S3 File Browser API
// List, read, and sign presigned URLs for files under a bot's S3 prefix

import type { FastifyPluginAsync } from 'fastify';
import {
  S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../config.js';
import { getBot } from '../../services/dynamo.js';
import { validateRelativeKey, MAX_UPLOAD_BYTES } from './files-utils.js';

const s3 = new S3Client({ region: config.region });

const PRESIGN_EXPIRES_SECONDS = 900;

export const filesRoutes: FastifyPluginAsync = async (app) => {
  // List files/folders under a bot's S3 prefix
  app.get<{ Params: { botId: string }; Querystring: { prefix?: string } }>(
    '/',
    async (request, reply) => {
      const { botId } = request.params;
      const bot = await getBot(request.userId, botId);
      if (!bot) return reply.status(404).send({ error: 'Bot not found' });

      const bucket = config.s3Bucket;
      const basePrefix = `${request.userId}/${botId}/`;
      const relativePrefix = request.query.prefix || '';
      const fullPrefix = basePrefix + relativePrefix;

      const result = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: fullPrefix,
        Delimiter: '/',
      }));

      const folders = (result.CommonPrefixes || []).map(p => ({
        key: p.Prefix!.slice(basePrefix.length),
        name: p.Prefix!.slice(fullPrefix.length).replace(/\/$/, ''),
        isFolder: true,
      }));

      const files = (result.Contents || [])
        .filter(obj => obj.Key !== fullPrefix)
        .map(obj => ({
          key: obj.Key!.slice(basePrefix.length),
          name: obj.Key!.slice(fullPrefix.length),
          isFolder: false,
          size: obj.Size,
          lastModified: obj.LastModified?.toISOString(),
        }));

      return { entries: [...folders, ...files] };
    },
  );

  // Get file content
  app.get<{ Params: { botId: string }; Querystring: { key: string } }>(
    '/content',
    async (request, reply) => {
      const { botId } = request.params;
      const key = request.query.key;
      if (!key) return reply.status(400).send({ error: 'key query param required' });

      const bot = await getBot(request.userId, botId);
      if (!bot) return reply.status(404).send({ error: 'Bot not found' });

      const bucket = config.s3Bucket;
      const fullKey = `${request.userId}/${botId}/${key}`;

      try {
        const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: fullKey }));
        const body = await result.Body?.transformToString();
        return {
          content: body || '',
          size: result.ContentLength || 0,
          lastModified: result.LastModified?.toISOString(),
          contentType: result.ContentType,
        };
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'NoSuchKey') {
          return reply.status(404).send({ error: 'File not found' });
        }
        throw err;
      }
    },
  );

  // POST /bots/:botId/files/upload-url — get a presigned PUT URL
  app.post<{
    Params: { botId: string };
    Body: { key: string; contentType?: string; size: number };
  }>(
    '/upload-url',
    async (request, reply) => {
      const { botId } = request.params;
      const { key, contentType, size } = request.body ?? ({} as never);

      if (typeof size !== 'number' || size < 0) {
        return reply.status(400).send({ error: 'size must be a non-negative number' });
      }
      if (size > MAX_UPLOAD_BYTES) {
        return reply.status(400).send({
          error: `File too large (max ${MAX_UPLOAD_BYTES} bytes)`,
        });
      }

      let safeKey: string;
      try {
        safeKey = validateRelativeKey(key);
      } catch {
        return reply.status(400).send({ error: 'invalid key' });
      }

      const bot = await getBot(request.userId, botId);
      if (!bot) return reply.status(404).send({ error: 'Bot not found' });

      const fullKey = `${request.userId}/${botId}/${safeKey}`;
      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: config.s3Bucket,
          Key: fullKey,
          ContentType: contentType || 'application/octet-stream',
        }),
        { expiresIn: PRESIGN_EXPIRES_SECONDS },
      );

      return { url, expiresIn: PRESIGN_EXPIRES_SECONDS };
    },
  );
};
