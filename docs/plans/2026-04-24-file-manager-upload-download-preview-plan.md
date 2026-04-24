# File Manager Upload/Download/Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add file upload (presigned PUT), download (presigned GET), and multi-format preview (markdown / html / image / text) to the web console Files tab.

**Architecture:** Browser ↔ S3 direct transfer via short-lived presigned URLs issued by control-plane. Preview uses type-specific renderers in a new `FilePreview.tsx`. Text and markdown keep using the existing `/files/content` endpoint; binary and HTML use presigned GET with `disposition=inline`. No path whitelist — read/write parity.

**Tech Stack:** Fastify 5 (control-plane), React 19 + Vite + TailwindCSS (web-console), AWS CDK 2 (infra), `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (already installed), vitest (control-plane tests).

**Design doc:** `docs/plans/2026-04-24-file-manager-upload-download-preview-design.md`

**Branch:** `feat/file-manager-upload-download-preview`

---

## File structure

**Create:**
- `control-plane/src/routes/api/files-utils.ts` — pure helpers: `validateRelativeKey`, `MAX_UPLOAD_BYTES`
- `control-plane/src/__tests__/files-utils.test.ts` — unit tests for the helpers
- `web-console/src/components/FilePreview.tsx` — type-dispatching preview renderer
- `web-console/src/components/UploadQueue.tsx` — floating upload progress panel
- `web-console/src/components/ConfirmOverwriteDialog.tsx` — overwrite confirmation modal

**Modify:**
- `control-plane/src/routes/api/files.ts` — add POST `/upload-url`, GET `/download-url`
- `infra/lib/foundation-stack.ts` — add CORS rule to `dataBucket`
- `web-console/src/lib/api.ts` — extend `files` client with `uploadUrl`, `downloadUrl`
- `web-console/src/components/FileBrowser.tsx` — wire Upload button, drop zone, mount UploadQueue, replace inline preview with `<FilePreview>`
- `web-console/src/locales/en.json` + `zh.json` — add Files-tab strings
- `web-console/package.json` — add `react-markdown`, `remark-gfm`, `rehype-sanitize`

---

## Task 1: Backend — pure validators with TDD

**Files:**
- Create: `control-plane/src/routes/api/files-utils.ts`
- Create: `control-plane/src/__tests__/files-utils.test.ts`

- [ ] **Step 1.1: Write failing tests**

Create `control-plane/src/__tests__/files-utils.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateRelativeKey, MAX_UPLOAD_BYTES } from '../routes/api/files-utils.js';

describe('validateRelativeKey', () => {
  it('accepts a normal relative key', () => {
    expect(validateRelativeKey('shared/a.txt')).toBe('shared/a.txt');
  });

  it('accepts a single file at root', () => {
    expect(validateRelativeKey('CLAUDE.md')).toBe('CLAUDE.md');
  });

  it('normalizes redundant slashes', () => {
    expect(validateRelativeKey('a//b/./c.txt')).toBe('a/b/c.txt');
  });

  it('rejects empty key', () => {
    expect(() => validateRelativeKey('')).toThrow(/invalid key/);
  });

  it('rejects leading slash', () => {
    expect(() => validateRelativeKey('/abs/path')).toThrow(/invalid key/);
  });

  it('rejects .. segments', () => {
    expect(() => validateRelativeKey('../etc/passwd')).toThrow(/invalid key/);
  });

  it('rejects .. segments in the middle', () => {
    expect(() => validateRelativeKey('a/../b')).toThrow(/invalid key/);
  });

  it('rejects pure ..', () => {
    expect(() => validateRelativeKey('..')).toThrow(/invalid key/);
  });
});

describe('MAX_UPLOAD_BYTES', () => {
  it('is 100 MB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
  });
});
```

- [ ] **Step 1.2: Run tests, expect failure**

Run: `npm test -w control-plane -- files-utils`
Expected: FAIL — `Cannot find module '../routes/api/files-utils.js'`

- [ ] **Step 1.3: Write implementation**

Create `control-plane/src/routes/api/files-utils.ts`:

```ts
// ClawBot Cloud — File routes shared helpers
import { posix } from 'node:path';

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Validate and normalize a user-supplied relative S3 key.
 * Rejects empty, leading-slash, and any key that normalizes to one
 * containing .. segments (path-traversal attempt).
 */
export function validateRelativeKey(key: string): string {
  if (!key || typeof key !== 'string') throw new Error('invalid key');
  if (key.startsWith('/')) throw new Error('invalid key');
  const norm = posix.normalize(key);
  if (norm === '..' || norm.startsWith('../') || norm.includes('/../') || norm.endsWith('/..')) {
    throw new Error('invalid key');
  }
  return norm;
}
```

- [ ] **Step 1.4: Run tests, expect pass**

Run: `npm test -w control-plane -- files-utils`
Expected: PASS — 9/9 tests

- [ ] **Step 1.5: Typecheck**

Run: `npm run typecheck -w control-plane`
Expected: no errors

- [ ] **Step 1.6: Commit**

```bash
git add control-plane/src/routes/api/files-utils.ts \
        control-plane/src/__tests__/files-utils.test.ts
git commit -m "feat(control-plane): add key/size validators for file routes"
```

---

## Task 2: Backend — POST /upload-url route

**Files:**
- Modify: `control-plane/src/routes/api/files.ts`

- [ ] **Step 2.1: Add imports and route**

Edit `control-plane/src/routes/api/files.ts`. Change imports at top:

```ts
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
```

Then, inside the `filesRoutes` plugin, after the existing `/content` route, add:

```ts
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
```

- [ ] **Step 2.2: Typecheck**

Run: `npm run typecheck -w control-plane`
Expected: no errors

- [ ] **Step 2.3: Build**

Run: `npm run build -w control-plane`
Expected: succeeds, emits to `dist/`

- [ ] **Step 2.4: Commit**

```bash
git add control-plane/src/routes/api/files.ts
git commit -m "feat(control-plane): add POST /files/upload-url for presigned PUT"
```

---

## Task 3: Backend — GET /download-url route

**Files:**
- Modify: `control-plane/src/routes/api/files.ts`

- [ ] **Step 3.1: Append the route**

Inside `filesRoutes`, after the `/upload-url` route, add:

```ts
  // GET /bots/:botId/files/download-url — get a presigned GET URL
  app.get<{
    Params: { botId: string };
    Querystring: { key: string; disposition?: 'attachment' | 'inline' };
  }>(
    '/download-url',
    async (request, reply) => {
      const { botId } = request.params;
      const { key, disposition = 'attachment' } = request.query;

      if (disposition !== 'attachment' && disposition !== 'inline') {
        return reply.status(400).send({ error: 'invalid disposition' });
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
      const filename = safeKey.split('/').pop() ?? 'file';

      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: config.s3Bucket,
          Key: fullKey,
          ResponseContentDisposition:
            `${disposition}; filename="${encodeURIComponent(filename)}"`,
        }),
        { expiresIn: PRESIGN_EXPIRES_SECONDS },
      );

      return { url, expiresIn: PRESIGN_EXPIRES_SECONDS };
    },
  );
```

- [ ] **Step 3.2: Typecheck + build**

Run: `npm run typecheck -w control-plane && npm run build -w control-plane`
Expected: no errors

- [ ] **Step 3.3: Run existing tests to confirm no regression**

Run: `npm test -w control-plane`
Expected: all tests pass

- [ ] **Step 3.4: Commit**

```bash
git add control-plane/src/routes/api/files.ts
git commit -m "feat(control-plane): add GET /files/download-url for presigned GET"
```

---

## Task 4: Infra — S3 CORS on data bucket

**Files:**
- Modify: `infra/lib/foundation-stack.ts`

- [ ] **Step 4.1: Verify `HttpMethods` is available from the existing import**

Run: `grep -n "from 'aws-cdk-lib/aws-s3'" /home/ubuntu/workspace/sample-cloud-native-nanoclaw/infra/lib/foundation-stack.ts`
Expected: one import line like `import * as s3 from 'aws-cdk-lib/aws-s3';` — `s3.HttpMethods` is what we'll use.

- [ ] **Step 4.2: Add CORS rule**

Edit `infra/lib/foundation-stack.ts`. After the `this.dataBucket = new s3.Bucket(...)` block (currently ends at line ~73 with `],\n    });`), insert:

```ts
    // ── S3 CORS — allow browser presigned PUT/GET from any origin ──────
    // Access is gated by SigV4 signatures in presigned URLs, not by CORS.
    this.dataBucket.addCorsRule({
      allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
      allowedOrigins: ['*'],
      allowedHeaders: ['*'],
      exposedHeaders: ['ETag'],
      maxAge: 3000,
    });
```

- [ ] **Step 4.3: Typecheck**

Run: `npm run typecheck -w infra`
Expected: no errors

- [ ] **Step 4.4: CDK synth (dry-run, agentcore mode)**

Run: `cd infra && npx cdk synth NanoClawbot-Foundation-dev 2>&1 | grep -A 10 '"CorsConfiguration"' | head -20`
Expected: synthesized template includes CorsRules with GET/PUT/HEAD and `"AllowedOrigins": ["*"]`. If stack name differs, run `npx cdk list` first and use the matching Foundation stack name.

- [ ] **Step 4.5: Commit**

```bash
git add infra/lib/foundation-stack.ts
git commit -m "feat(infra): add CORS rule on data bucket for browser presigned URL access"
```

---

## Task 5: Frontend — extend `files` API client

**Files:**
- Modify: `web-console/src/lib/api.ts`

- [ ] **Step 5.1: Replace the `files` export**

Edit `web-console/src/lib/api.ts`. Find the existing `files` export (around line 407):

```ts
// File Browser API
export const files = {
  list: (botId: string, prefix?: string) =>
    request<{ entries: FileEntry[] }>(`/bots/${botId}/files${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''}`),
  content: (botId: string, key: string) =>
    request<FileContent>(`/bots/${botId}/files/content?key=${encodeURIComponent(key)}`),
};
```

Replace with:

```ts
// File Browser API
export interface PresignedUrlResponse {
  url: string;
  expiresIn: number;
}

export const files = {
  list: (botId: string, prefix?: string) =>
    request<{ entries: FileEntry[] }>(`/bots/${botId}/files${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''}`),
  content: (botId: string, key: string) =>
    request<FileContent>(`/bots/${botId}/files/content?key=${encodeURIComponent(key)}`),
  uploadUrl: (
    botId: string,
    body: { key: string; contentType: string; size: number },
  ) =>
    request<PresignedUrlResponse>(
      `/bots/${botId}/files/upload-url`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  downloadUrl: (
    botId: string,
    key: string,
    disposition: 'attachment' | 'inline' = 'attachment',
  ) =>
    request<PresignedUrlResponse>(
      `/bots/${botId}/files/download-url?key=${encodeURIComponent(key)}` +
      `&disposition=${disposition}`,
    ),
};
```

- [ ] **Step 5.2: Typecheck**

Run: `npm run build -w web-console 2>&1 | tail -20`
Expected: builds successfully (no TS errors). If any existing page imports from `api.ts` break, fix the import.

- [ ] **Step 5.3: Commit**

```bash
git add web-console/src/lib/api.ts
git commit -m "feat(web-console): add uploadUrl/downloadUrl to files API client"
```

---

## Task 6: Frontend — install markdown/html preview deps

**Files:**
- Modify: `web-console/package.json`
- Modify: `package-lock.json`

- [ ] **Step 6.1: Install packages**

Run from repo root:

```bash
npm install -w web-console react-markdown@^9 remark-gfm@^4 rehype-sanitize@^6
```

Expected: adds three entries under `web-console/package.json` `dependencies`, updates `package-lock.json`.

- [ ] **Step 6.2: Verify install**

Run: `ls /home/ubuntu/workspace/sample-cloud-native-nanoclaw/node_modules/react-markdown /home/ubuntu/workspace/sample-cloud-native-nanoclaw/node_modules/remark-gfm /home/ubuntu/workspace/sample-cloud-native-nanoclaw/node_modules/rehype-sanitize`
Expected: all three directories exist.

- [ ] **Step 6.3: Build to confirm no conflict**

Run: `npm run build -w web-console 2>&1 | tail -5`
Expected: build succeeds.

- [ ] **Step 6.4: Commit**

```bash
git add web-console/package.json package-lock.json
git commit -m "chore(web-console): add react-markdown, remark-gfm, rehype-sanitize"
```

---

## Task 7: Frontend — create `FilePreview.tsx`

**Files:**
- Create: `web-console/src/components/FilePreview.tsx`

- [ ] **Step 7.1: Write the component**

Create `web-console/src/components/FilePreview.tsx`:

```tsx
import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Download, AlertCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { files as filesApi, FileContent } from '../lib/api';

/* ── helpers ──────────────────────────────────────────────────────── */

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const TEXT_EXTS = [
  'txt','json','yml','yaml','js','ts','tsx','jsx','py','rs','go',
  'java','c','cpp','h','sh','toml','xml','csv','log','env','mjs',
  'cjs','css','scss','conf','ini',
];
const IMAGE_EXTS = ['png','jpg','jpeg','gif','webp','svg','bmp'];

type Renderer = 'markdown' | 'html' | 'image' | 'text' | 'binary';

function pickRenderer(key: string): Renderer {
  const ext = key.toLowerCase().split('.').pop() ?? '';
  if (['md','markdown'].includes(ext)) return 'markdown';
  if (['html','htm'].includes(ext)) return 'html';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (TEXT_EXTS.includes(ext)) return 'text';
  return 'binary';
}

/* ── FilePreview ──────────────────────────────────────────────────── */

export default function FilePreview({
  botId,
  fileKey,
}: {
  botId: string;
  fileKey: string;
}) {
  const { t } = useTranslation();
  const renderer = useMemo(() => pickRenderer(fileKey), [fileKey]);

  const [textContent, setTextContent] = useState<FileContent | null>(null);
  const [binaryUrl, setBinaryUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered');

  // Load data for current file
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTextContent(null);
    setBinaryUrl(null);
    setViewMode('rendered');

    (async () => {
      try {
        if (renderer === 'markdown' || renderer === 'text') {
          const c = await filesApi.content(botId, fileKey);
          if (!cancelled) setTextContent(c);
        } else if (renderer === 'html') {
          // Source mode needs text, rendered mode needs presigned URL — load both
          const [c, u] = await Promise.all([
            filesApi.content(botId, fileKey),
            filesApi.downloadUrl(botId, fileKey, 'inline'),
          ]);
          if (!cancelled) {
            setTextContent(c);
            setBinaryUrl(u.url);
          }
        } else if (renderer === 'image') {
          const u = await filesApi.downloadUrl(botId, fileKey, 'inline');
          if (!cancelled) setBinaryUrl(u.url);
        } else {
          // binary — metadata only via list (already in tree) / no fetch
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [botId, fileKey, renderer]);

  const onDownload = async () => {
    try {
      const { url } = await filesApi.downloadUrl(botId, fileKey, 'attachment');
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1 text-sm text-slate-400">
        {t('botDetail.files.loadingFile')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 text-sm text-red-500 gap-2">
        <AlertCircle size={24} />
        <span>{error}</span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-200 bg-white flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-900 font-mono truncate">{fileKey}</p>
          <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
            {textContent?.size != null && (
              <span>{t('botDetail.files.size', { size: formatBytes(textContent.size) })}</span>
            )}
            {textContent?.lastModified && (
              <span>{t('botDetail.files.modified', { date: formatDate(textContent.lastModified) })}</span>
            )}
            {textContent?.contentType && <span>{textContent.contentType}</span>}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {(renderer === 'markdown' || renderer === 'html') && (
            <div className="flex rounded-md border border-slate-200 overflow-hidden text-xs">
              <button
                onClick={() => setViewMode('rendered')}
                className={viewMode === 'rendered'
                  ? 'px-2 py-1 bg-accent-50 text-accent-700 font-medium'
                  : 'px-2 py-1 text-slate-600 hover:bg-slate-100'}
              >
                {t('botDetail.files.preview.rendered')}
              </button>
              <button
                onClick={() => setViewMode('source')}
                className={viewMode === 'source'
                  ? 'px-2 py-1 bg-accent-50 text-accent-700 font-medium'
                  : 'px-2 py-1 text-slate-600 hover:bg-slate-100'}
              >
                {t('botDetail.files.preview.source')}
              </button>
            </div>
          )}
          <button
            onClick={onDownload}
            className="flex items-center gap-1 px-2 py-1 text-xs text-slate-600 border border-slate-200 rounded-md hover:bg-slate-100"
            title={t('botDetail.files.download')}
          >
            <Download size={14} />
            {t('botDetail.files.download')}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto bg-white">
        {renderer === 'markdown' && textContent && (
          viewMode === 'rendered' ? (
            <div className="prose prose-slate max-w-none p-6">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSanitize]}
              >
                {textContent.content}
              </ReactMarkdown>
            </div>
          ) : (
            <TextView content={textContent.content} />
          )
        )}

        {renderer === 'html' && (
          viewMode === 'rendered' && binaryUrl ? (
            <iframe
              src={binaryUrl}
              sandbox="allow-same-origin"
              className="w-full h-full border-0"
              title={fileKey}
            />
          ) : textContent ? (
            <TextView content={textContent.content} />
          ) : null
        )}

        {renderer === 'image' && binaryUrl && (
          <div className="flex items-center justify-center h-full p-4 bg-slate-50">
            <img
              src={binaryUrl}
              alt={fileKey}
              className="max-w-full max-h-full object-contain"
              onError={() => setError(t('botDetail.files.preview.imageFailed'))}
            />
          </div>
        )}

        {renderer === 'text' && textContent && (
          <TextView content={textContent.content} />
        )}

        {renderer === 'binary' && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400 p-8">
            <FileText size={40} strokeWidth={1.5} />
            <p className="text-sm">{t('botDetail.files.preview.noPreview')}</p>
            <button
              onClick={onDownload}
              className="flex items-center gap-1 mt-2 px-3 py-1.5 text-sm text-white bg-accent-600 rounded-md hover:bg-accent-700"
            >
              <Download size={14} />
              {t('botDetail.files.download')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Reusable text view (same look as the previous inline one) ────── */

function TextView({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <pre className="font-mono text-sm leading-relaxed">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className="hover:bg-slate-100/50">
              <td className="select-none text-right pr-4 pl-4 py-0 text-slate-400 text-xs align-top w-12 border-r border-slate-200 bg-white/60">
                {i + 1}
              </td>
              <td className="pl-4 pr-4 py-0 whitespace-pre-wrap break-all">
                {line || ' '}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </pre>
  );
}
```

- [ ] **Step 7.2: Build**

Run: `npm run build -w web-console 2>&1 | tail -15`
Expected: build succeeds (i18n keys referenced here don't exist yet but TS doesn't know that — will be added in Task 10).

- [ ] **Step 7.3: Commit**

```bash
git add web-console/src/components/FilePreview.tsx
git commit -m "feat(web-console): add FilePreview with markdown/html/image/text/binary renderers"
```

---

## Task 8: Frontend — `ConfirmOverwriteDialog` + `UploadQueue`

**Files:**
- Create: `web-console/src/components/ConfirmOverwriteDialog.tsx`
- Create: `web-console/src/components/UploadQueue.tsx`

- [ ] **Step 8.1: ConfirmOverwriteDialog**

Create `web-console/src/components/ConfirmOverwriteDialog.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import { AlertTriangle, X } from 'lucide-react';

export interface OverwriteInfo {
  key: string;
  oldSize?: number;
  oldLastModified?: string;
  newSize: number;
}

export type OverwriteChoice = 'overwrite' | 'skip' | 'overwrite-all' | 'skip-all';

function formatBytes(n?: number): string {
  if (n == null) return '—';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function ConfirmOverwriteDialog({
  info,
  onChoose,
  onClose,
}: {
  info: OverwriteInfo;
  onChoose: (choice: OverwriteChoice) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-[480px] max-w-[90vw]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-amber-500" />
            <h3 className="text-base font-semibold text-slate-900">
              {t('botDetail.files.overwriteTitle')}
            </h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-4 text-sm text-slate-700">
          <p className="mb-3">
            {t('botDetail.files.overwriteBody', { key: info.key })}
          </p>
          <div className="grid grid-cols-2 gap-3 text-xs bg-slate-50 rounded-md p-3">
            <div>
              <div className="text-slate-400 mb-0.5">{t('botDetail.files.overwriteExisting')}</div>
              <div className="font-mono">{formatBytes(info.oldSize)}</div>
              <div className="text-slate-500">
                {info.oldLastModified
                  ? new Date(info.oldLastModified).toLocaleString()
                  : '—'}
              </div>
            </div>
            <div>
              <div className="text-slate-400 mb-0.5">{t('botDetail.files.overwriteNew')}</div>
              <div className="font-mono">{formatBytes(info.newSize)}</div>
              <div className="text-slate-500">{t('botDetail.files.overwriteNow')}</div>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-slate-200">
          <div className="flex gap-2">
            <button
              onClick={() => onChoose('skip-all')}
              className="px-3 py-1.5 text-xs text-slate-600 border border-slate-200 rounded-md hover:bg-slate-100"
            >
              {t('botDetail.files.skipAll')}
            </button>
            <button
              onClick={() => onChoose('overwrite-all')}
              className="px-3 py-1.5 text-xs text-slate-600 border border-slate-200 rounded-md hover:bg-slate-100"
            >
              {t('botDetail.files.overwriteAll')}
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => onChoose('skip')}
              className="px-3 py-1.5 text-sm text-slate-600 border border-slate-200 rounded-md hover:bg-slate-100"
            >
              {t('botDetail.files.skip')}
            </button>
            <button
              onClick={() => onChoose('overwrite')}
              className="px-3 py-1.5 text-sm text-white bg-accent-600 rounded-md hover:bg-accent-700"
            >
              {t('botDetail.files.overwrite')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8.2: UploadQueue**

Create `web-console/src/components/UploadQueue.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, CheckCircle2, AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';

export type UploadStatus = 'pending' | 'uploading' | 'done' | 'failed' | 'skipped';

export interface UploadItem {
  id: string;
  name: string;
  key: string;
  size: number;
  progress: number; // 0..100
  status: UploadStatus;
  error?: string;
}

export default function UploadQueue({
  items,
  onRetry,
  onDismiss,
}: {
  items: UploadItem[];
  onRetry: (id: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState(false);

  // Auto-hide 3s after every item is resolved
  useEffect(() => {
    if (items.length === 0) return;
    const allResolved = items.every(
      (i) => i.status === 'done' || i.status === 'failed' || i.status === 'skipped',
    );
    if (!allResolved) return;
    const failed = items.some((i) => i.status === 'failed');
    if (failed) return; // keep visible until user dismisses
    const timer = setTimeout(() => {
      setHidden(true);
      onDismiss();
    }, 3000);
    return () => clearTimeout(timer);
  }, [items, onDismiss]);

  if (hidden || items.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 bg-slate-50">
        <span className="text-xs font-semibold text-slate-600 uppercase tracking-wider">
          {t('botDetail.files.uploading')}
        </span>
        <button
          onClick={() => { setHidden(true); onDismiss(); }}
          className="text-slate-400 hover:text-slate-600"
        >
          <X size={14} />
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {items.map((item) => (
          <div key={item.id} className="px-3 py-2 border-b border-slate-50 last:border-b-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-slate-700 font-mono truncate" title={item.key}>
                {item.name}
              </span>
              <StatusIcon status={item.status} />
            </div>
            <div className="mt-1 h-1 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={clsx(
                  'h-full transition-all',
                  item.status === 'failed' ? 'bg-red-400' : 'bg-accent-500',
                )}
                style={{ width: `${item.progress}%` }}
              />
            </div>
            {item.status === 'failed' && (
              <div className="flex items-center justify-between mt-1">
                <span className="text-xs text-red-500 truncate">{item.error}</span>
                <button
                  onClick={() => onRetry(item.id)}
                  className="flex items-center gap-0.5 text-xs text-accent-600 hover:text-accent-700"
                >
                  <RefreshCw size={12} />
                  {t('botDetail.files.retry')}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: UploadStatus }) {
  if (status === 'uploading') return <Loader2 size={14} className="animate-spin text-accent-500" />;
  if (status === 'done') return <CheckCircle2 size={14} className="text-emerald-500" />;
  if (status === 'failed') return <AlertCircle size={14} className="text-red-500" />;
  return null;
}
```

- [ ] **Step 8.3: Build**

Run: `npm run build -w web-console 2>&1 | tail -15`
Expected: build succeeds.

- [ ] **Step 8.4: Commit**

```bash
git add web-console/src/components/ConfirmOverwriteDialog.tsx \
        web-console/src/components/UploadQueue.tsx
git commit -m "feat(web-console): add overwrite dialog and upload queue components"
```

---

## Task 9: Frontend — wire uploads into `FileBrowser`

**Files:**
- Modify: `web-console/src/components/FileBrowser.tsx`

- [ ] **Step 9.1: Rewrite FileBrowser**

Replace the full contents of `web-console/src/components/FileBrowser.tsx` with:

```tsx
import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight, ChevronDown, Folder, FolderOpen,
  FileText, RefreshCw, Upload,
} from 'lucide-react';
import { clsx } from 'clsx';
import { files as filesApi, FileEntry } from '../lib/api';
import FilePreview from './FilePreview';
import UploadQueue, { UploadItem } from './UploadQueue';
import ConfirmOverwriteDialog, {
  OverwriteInfo, OverwriteChoice,
} from './ConfirmOverwriteDialog';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/* ── TreeNode ─────────────────────────────────────────────────────── */

function TreeNode({
  entry,
  depth,
  botId,
  tree,
  expandedFolders,
  selectedFile,
  selectedFolder,
  onToggleFolder,
  onSelectFile,
  onSelectFolder,
}: {
  entry: FileEntry;
  depth: number;
  botId: string;
  tree: Record<string, FileEntry[]>;
  expandedFolders: Set<string>;
  selectedFile: string | null;
  selectedFolder: string;
  onToggleFolder: (key: string) => void;
  onSelectFile: (key: string) => void;
  onSelectFolder: (key: string) => void;
}) {
  const isExpanded = expandedFolders.has(entry.key);
  const isSelected = selectedFile === entry.key;
  const isFolderSelected = entry.isFolder && selectedFolder === entry.key;
  const children = tree[entry.key] || [];

  if (entry.isFolder) {
    return (
      <div>
        <button
          onClick={() => {
            onToggleFolder(entry.key);
            onSelectFolder(entry.key);
          }}
          className={clsx(
            'flex items-center gap-1.5 w-full text-left py-1.5 pr-3 text-sm transition-colors rounded-md',
            isFolderSelected
              ? 'bg-accent-50 text-accent-700'
              : 'text-slate-700 hover:bg-slate-100',
          )}
          style={{ paddingLeft: depth * 16 + 12 }}
        >
          {isExpanded
            ? <ChevronDown size={14} className="text-slate-400 shrink-0" />
            : <ChevronRight size={14} className="text-slate-400 shrink-0" />}
          {isExpanded
            ? <FolderOpen size={15} className="text-amber-500 shrink-0" />
            : <Folder size={15} className="text-amber-500 shrink-0" />}
          <span className="truncate">{entry.name}</span>
        </button>
        {isExpanded && children.map((child) => (
          <TreeNode
            key={child.key}
            entry={child}
            depth={depth + 1}
            botId={botId}
            tree={tree}
            expandedFolders={expandedFolders}
            selectedFile={selectedFile}
            selectedFolder={selectedFolder}
            onToggleFolder={onToggleFolder}
            onSelectFile={onSelectFile}
            onSelectFolder={onSelectFolder}
          />
        ))}
      </div>
    );
  }

  return (
    <button
      onClick={() => onSelectFile(entry.key)}
      className={clsx(
        'flex items-center gap-1.5 w-full text-left py-1.5 pr-3 text-sm transition-colors rounded-md',
        isSelected
          ? 'bg-accent-50 text-accent-700 font-medium'
          : 'text-slate-700 hover:bg-slate-100',
      )}
      style={{ paddingLeft: depth * 16 + 12 + 18 }}
    >
      <FileText size={15} className={clsx('shrink-0', isSelected ? 'text-accent-500' : 'text-slate-400')} />
      <span className="truncate">{entry.name}</span>
    </button>
  );
}

/* ── FileBrowser ──────────────────────────────────────────────────── */

export default function FileBrowser({ botId }: { botId: string }) {
  const { t } = useTranslation();
  const [tree, setTree] = useState<Record<string, FileEntry[]>>({});
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [pending, setPending] = useState<File[]>([]);
  const [overwrite, setOverwrite] = useState<{
    file: File;
    info: OverwriteInfo;
  } | null>(null);
  const [overwriteAll, setOverwriteAll] = useState<boolean>(false);
  const [skipAll, setSkipAll] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFolder = useCallback(async (prefix: string) => {
    if (prefix === '') setLoading(true);
    setError(null);
    try {
      const result = await filesApi.list(botId, prefix || undefined);
      setTree((prev) => ({ ...prev, [prefix]: result.entries }));
    } catch (err) {
      console.error('Failed to load folder:', err);
      if (prefix === '') setError(t('botDetail.files.failedToLoad'));
    } finally {
      if (prefix === '') setLoading(false);
    }
  }, [botId, t]);

  useEffect(() => { loadFolder(''); }, [loadFolder]);

  const handleToggleFolder = useCallback(async (key: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    if (!tree[key]) await loadFolder(key);
  }, [tree, loadFolder]);

  const handleRefresh = useCallback(async () => {
    setTree({});
    setExpandedFolders(new Set());
    setSelectedFile(null);
    setSelectedFolder('');
    await loadFolder('');
  }, [loadFolder]);

  /* ── Upload pipeline ─────────────────────────────────────────────── */

  const targetPrefix = selectedFolder; // '' means root

  const enqueueFiles = (fs: File[]) => {
    const accepted: File[] = [];
    const rejected: UploadItem[] = [];
    for (const f of fs) {
      if (f.size > MAX_UPLOAD_BYTES) {
        rejected.push({
          id: crypto.randomUUID(),
          name: f.name,
          key: targetPrefix + f.name,
          size: f.size,
          progress: 0,
          status: 'failed',
          error: t('botDetail.files.uploadTooLarge'),
        });
      } else {
        accepted.push(f);
      }
    }
    if (rejected.length > 0) setUploads((u) => [...u, ...rejected]);
    if (accepted.length > 0) setPending((p) => [...p, ...accepted]);
  };

  // Process pending queue — dequeues one at a time, but XHRs run concurrently
  useEffect(() => {
    if (pending.length === 0 || overwrite) return;
    const next = pending[0];
    const key = targetPrefix + next.name;

    const siblings = tree[targetPrefix] || [];
    const existing = siblings.find((e) => !e.isFolder && e.key === key);

    const proceed = () => startUpload(next, key);
    const skip = () => {
      setUploads((u) => [...u, {
        id: crypto.randomUUID(),
        name: next.name, key,
        size: next.size, progress: 0,
        status: 'skipped',
      }]);
      setPending((p) => p.slice(1));
    };

    if (existing) {
      if (overwriteAll) { proceed(); return; }
      if (skipAll) { skip(); return; }
      setOverwrite({
        file: next,
        info: {
          key,
          oldSize: existing.size,
          oldLastModified: existing.lastModified,
          newSize: next.size,
        },
      });
    } else {
      proceed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, overwrite, overwriteAll, skipAll, tree, targetPrefix]);

  const startUpload = (file: File, key: string) => {
    const id = crypto.randomUUID();
    const contentType = file.type || 'application/octet-stream';
    setUploads((u) => [...u, {
      id, name: file.name, key, size: file.size,
      progress: 0, status: 'uploading',
    }]);
    setPending((p) => p.slice(1));

    (async () => {
      try {
        const { url } = await filesApi.uploadUrl(botId, {
          key, contentType, size: file.size,
        });
        await putWithProgress(url, file, contentType, (pct) => {
          setUploads((u) => u.map((it) => it.id === id ? { ...it, progress: pct } : it));
        });
        setUploads((u) => u.map((it) => it.id === id
          ? { ...it, progress: 100, status: 'done' }
          : it));
        // refresh parent folder
        await loadFolder(targetPrefix);
      } catch (e) {
        setUploads((u) => u.map((it) => it.id === id
          ? { ...it, status: 'failed', error: e instanceof Error ? e.message : String(e) }
          : it));
      }
    })();
  };

  const onOverwriteChoice = (choice: OverwriteChoice) => {
    if (!overwrite) return;
    const { file, info } = overwrite;
    setOverwrite(null);
    if (choice === 'overwrite-all') { setOverwriteAll(true); startUpload(file, info.key); return; }
    if (choice === 'overwrite')     { startUpload(file, info.key); return; }
    if (choice === 'skip-all')      { setSkipAll(true); }
    // skip or skip-all: mark skipped
    setUploads((u) => [...u, {
      id: crypto.randomUUID(),
      name: file.name, key: info.key,
      size: file.size, progress: 0, status: 'skipped',
    }]);
    setPending((p) => p.slice(1));
  };

  const onRetry = (id: string) => {
    const failed = uploads.find((u) => u.id === id);
    if (!failed) return;
    setUploads((u) => u.filter((it) => it.id !== id));
    // try to recover the original file — not persisted, so just show message
    // User must re-select file. This is a known limitation; good enough for MVP.
  };

  /* ── Drag & drop ─────────────────────────────────────────────────── */

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = () => setDragOver(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) enqueueFiles(dropped);
  };

  const rootEntries = tree[''] || [];

  return (
    <div className="flex rounded-xl border border-slate-200 overflow-hidden bg-white" style={{ height: '600px' }}>
      {/* Left: folder tree */}
      <div
        className={clsx(
          'w-72 border-r border-slate-200 overflow-hidden bg-white flex-shrink-0 flex flex-col',
          dragOver && 'ring-2 ring-accent-400 ring-inset',
        )}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-100">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            {t('botDetail.files.explorer')}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-1 text-slate-400 hover:text-slate-600 transition-colors rounded"
              title={t('botDetail.files.upload')}
            >
              <Upload size={14} />
            </button>
            <button
              onClick={handleRefresh}
              className="p-1 text-slate-400 hover:text-slate-600 transition-colors rounded"
              title={t('botDetail.files.refresh')}
            >
              <RefreshCw size={14} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const fs = Array.from(e.target.files || []);
                if (fs.length > 0) enqueueFiles(fs);
                e.target.value = '';
              }}
            />
          </div>
        </div>

        {/* Upload target indicator */}
        <div className="px-3 py-1.5 text-[10px] text-slate-400 border-b border-slate-50 font-mono truncate">
          {t('botDetail.files.uploadTarget')}: /{targetPrefix || t('botDetail.files.rootFolder')}
        </div>

        <div className="flex-1 overflow-y-auto p-1.5">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-slate-400">
              {t('common.loading')}
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 text-sm text-slate-400 gap-2">
              <span>{error}</span>
              <button
                onClick={handleRefresh}
                className="text-accent-600 hover:text-accent-700 font-medium"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : rootEntries.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-sm text-slate-400">
              {dragOver ? t('botDetail.files.dropHere') : t('common.noFilesFound')}
            </div>
          ) : (
            rootEntries.map((entry) => (
              <TreeNode
                key={entry.key}
                entry={entry}
                depth={0}
                botId={botId}
                tree={tree}
                expandedFolders={expandedFolders}
                selectedFile={selectedFile}
                selectedFolder={selectedFolder}
                onToggleFolder={handleToggleFolder}
                onSelectFile={setSelectedFile}
                onSelectFolder={setSelectedFolder}
              />
            ))
          )}
        </div>
      </div>

      {/* Right: preview */}
      <div className="flex-1 overflow-hidden bg-slate-50 flex flex-col">
        {selectedFile ? (
          <FilePreview key={selectedFile} botId={botId} fileKey={selectedFile} />
        ) : (
          <div className="flex flex-col items-center justify-center flex-1 text-slate-400 gap-3">
            <FileText size={40} strokeWidth={1.5} />
            <p className="text-sm">{t('botDetail.files.selectFile')}</p>
          </div>
        )}
      </div>

      {overwrite && (
        <ConfirmOverwriteDialog
          info={overwrite.info}
          onChoose={onOverwriteChoice}
          onClose={() => {
            setOverwrite(null);
            setPending([]);
          }}
        />
      )}

      <UploadQueue
        items={uploads}
        onRetry={onRetry}
        onDismiss={() => setUploads([])}
      />
    </div>
  );
}

/* ── helpers ──────────────────────────────────────────────────────── */

function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) onProgress(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`PUT failed: ${xhr.status} ${xhr.statusText}`));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(file);
  });
}
```

- [ ] **Step 9.2: Build**

Run: `npm run build -w web-console 2>&1 | tail -15`
Expected: succeeds. If TS complains about missing i18n keys, those are string literals and will compile fine; actual missing translations are added in Task 10.

- [ ] **Step 9.3: Commit**

```bash
git add web-console/src/components/FileBrowser.tsx
git commit -m "feat(web-console): wire upload/download/preview into FileBrowser"
```

---

## Task 10: Frontend — i18n strings

**Files:**
- Modify: `web-console/src/locales/en.json`
- Modify: `web-console/src/locales/zh.json`

- [ ] **Step 10.1: Inspect current shape**

Run: `grep -n '"files"' /home/ubuntu/workspace/sample-cloud-native-nanoclaw/web-console/src/locales/en.json | head -5`
Expected: shows `"files": { ... }` block under `botDetail`. Note the exact key path.

- [ ] **Step 10.2: Add English strings**

Open `web-console/src/locales/en.json`, locate the `botDetail.files` object (same object that already contains `explorer`, `refresh`, `loadingFile`, `selectFile`, `failedToLoad`, `size`, `modified`). Add these keys inside that object (preserve existing entries):

```json
      "upload": "Upload",
      "uploadTarget": "Upload target",
      "rootFolder": "(root)",
      "download": "Download",
      "uploading": "Uploading",
      "uploadTooLarge": "File exceeds 100 MB limit",
      "retry": "Retry",
      "dropHere": "Drop files to upload",
      "overwriteTitle": "File already exists",
      "overwriteBody": "\"{{key}}\" already exists. Overwrite it?",
      "overwriteExisting": "Existing",
      "overwriteNew": "New",
      "overwriteNow": "Now",
      "overwrite": "Overwrite",
      "skip": "Skip",
      "overwriteAll": "Overwrite all",
      "skipAll": "Skip all",
      "preview": {
        "rendered": "Rendered",
        "source": "Source",
        "noPreview": "No preview available for this file type",
        "imageFailed": "Failed to render image"
      }
```

- [ ] **Step 10.3: Add Chinese strings**

In `web-console/src/locales/zh.json`, add to the same `botDetail.files` object:

```json
      "upload": "上传",
      "uploadTarget": "上传至",
      "rootFolder": "（根目录）",
      "download": "下载",
      "uploading": "上传中",
      "uploadTooLarge": "文件超过 100 MB 限制",
      "retry": "重试",
      "dropHere": "拖拽文件到此处上传",
      "overwriteTitle": "文件已存在",
      "overwriteBody": "\"{{key}}\" 已存在，是否覆盖？",
      "overwriteExisting": "现有文件",
      "overwriteNew": "新文件",
      "overwriteNow": "现在",
      "overwrite": "覆盖",
      "skip": "跳过",
      "overwriteAll": "全部覆盖",
      "skipAll": "全部跳过",
      "preview": {
        "rendered": "渲染视图",
        "source": "源码",
        "noPreview": "该文件类型暂不支持预览",
        "imageFailed": "图片渲染失败"
      }
```

- [ ] **Step 10.4: Validate JSON**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('web-console/src/locales/en.json','utf8'))" && \
node -e "JSON.parse(require('fs').readFileSync('web-console/src/locales/zh.json','utf8'))"
```
Expected: no output = both valid JSON.

- [ ] **Step 10.5: Build**

Run: `npm run build -w web-console 2>&1 | tail -5`
Expected: build succeeds.

- [ ] **Step 10.6: Commit**

```bash
git add web-console/src/locales/en.json web-console/src/locales/zh.json
git commit -m "i18n(web-console): add strings for file upload/download/preview"
```

---

## Task 11: Full verification

- [ ] **Step 11.1: Run all control-plane tests**

Run: `npm test -w control-plane`
Expected: all suites pass (including the 9 new `files-utils` cases).

- [ ] **Step 11.2: Run all typechecks**

Run:
```bash
npm run typecheck -w shared && \
npm run typecheck -w control-plane && \
npm run typecheck -w agent-runtime && \
npm run typecheck -w infra
```
Expected: no errors.

- [ ] **Step 11.3: Build everything**

Run: `npm run build --workspaces`
Expected: all packages build successfully.

- [ ] **Step 11.4: Manual smoke-test checklist**

This must be run in a deployed environment (or local dev with real AWS creds).
Tick each once verified:

- [ ] Upload a small `.txt` file via **Upload** button → appears in tree → clicking shows text with line numbers.
- [ ] Upload a `.md` file → preview renders with headings, tables (GFM), lists; toggling to **Source** shows raw markdown.
- [ ] Upload a `.png` → preview shows image inline, fits container.
- [ ] Upload an `.html` with inline `<script>alert(1)</script>` → renders in iframe; script does not execute (sandbox without `allow-scripts`).
- [ ] Upload an unknown `.foo` → placeholder + download button; clicking downloads.
- [ ] Click **Download** on any file → browser downloads with correct filename.
- [ ] Upload a file whose key already exists → confirm dialog appears → **Overwrite** succeeds; folder refreshes.
- [ ] Drag 3 files onto tree panel → all 3 upload with progress bars (concurrent OK); queue auto-hides after 3 s.
- [ ] Pick a file > 100 MB → red error in queue, zero network requests.
- [ ] Switch language zh ↔ en → all new strings translate.

- [ ] **Step 11.5: Final push**

```bash
git log --oneline feat/file-manager-upload-download-preview ^main
# review commit list
git push -u origin feat/file-manager-upload-download-preview
```

---

## Out of scope (explicit YAGNI)

- Delete, rename, new folder operations.
- Batch zip download.
- Multipart / resumable upload for files > 100 MB.
- Syntax highlighting for code files.
- Image thumbnails in tree.
- Access control beyond existing bot-ownership check.
- Retrying a failed upload with the original `File` object — the Retry button in the queue currently just removes the row; users must re-select the file.
