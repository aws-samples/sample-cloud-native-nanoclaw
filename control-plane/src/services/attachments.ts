// ClawBot Cloud — Attachment Download & Storage Service
// Downloads media from channel APIs and stores in S3 for agent consumption

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Attachment } from '@clawbot/shared';
import { config } from '../config.js';

const s3 = new S3Client({ region: config.region });
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

export async function downloadAndStore(
  userId: string,
  botId: string,
  messageId: string,
  url: string,
  fileName: string,
  mimeType: string,
  authHeaders?: Record<string, string>,
): Promise<Attachment | null> {
  const res = await fetch(url, { headers: authHeaders });
  if (!res.ok) return null;

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_FILE_SIZE) return null;

  const type = mimeType.startsWith('image/') ? ('image' as const) : ('document' as const);
  const s3Key = `${userId}/${botId}/attachments/${messageId}/${fileName}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: s3Key,
      Body: buffer,
      ContentType: mimeType,
    }),
  );

  return { type, s3Key, fileName, mimeType, size: buffer.length };
}
