# File Manager — Upload / Download / Multi-format Preview

**Date:** 2026-04-24
**Scope:** Web console → Bot detail page → **Files** tab
**Branch:** `feat/file-manager-upload-download-preview`

## Problem

The current **Files** tab (`web-console/src/components/FileBrowser.tsx`) is a read-only S3
browser: left-side folder tree + right-side plain-text line-numbered view. It calls two
endpoints on the control plane:

- `GET  /bots/:botId/files?prefix=…` → list folder
- `GET  /bots/:botId/files/content?key=…` → read as string

Users cannot upload files, cannot download files, and cannot preview images, HTML, or
rendered Markdown. Binary files render as garbled text.

## Goals

1. Upload files to any path the user can see (read/write parity — no whitelist).
2. Download any file to local disk.
3. Preview common formats natively:
   - Markdown → rendered
   - HTML → rendered in a sandboxed iframe
   - Images (png/jpg/gif/webp/svg/bmp) → `<img>`
   - Text/code → existing line-numbered view
   - Everything else → "no preview" placeholder with a download button

## Non-goals (YAGNI)

- Delete, rename, new folder — not in scope this round.
- Batch zip download.
- Multipart upload for files > 100 MB.
- Syntax highlighting on code files.
- Server-side HTML/Markdown rendering.

## Architecture

### S3 layout (unchanged)

All bot-scoped data lives under `${userId}/${botId}/` in the data bucket. No path
classification is added — any key the user can `ListObjectsV2` is also eligible for
`PutObject` and `GetObject` via presigned URLs.

### Data flow

#### Upload

```
Browser                 Control Plane              S3
  │                         │                       │
  │  POST /upload-url       │                       │
  ├────────────────────────>│                       │
  │                         │  getSignedUrl(PUT)    │
  │                         ├──────────────────────>│
  │                         │<──────────────────────┤
  │<────────────────────────┤                       │
  │                         │                       │
  │  PUT presignedUrl (body=File, CT=file.type)     │
  ├─────────────────────────────────────────────────>│
  │<─────────────────────────────────────────────────┤
  │                         │                       │
  │  refresh folder listing │                       │
  ├────────────────────────>│                       │
```

#### Download

```
Browser                 Control Plane              S3
  │  GET /download-url?key  │                       │
  ├────────────────────────>│                       │
  │                         │  getSignedUrl(GET,    │
  │                         │     ContentDisposition│
  │                         │     =attachment)      │
  │                         ├──────────────────────>│
  │                         │<──────────────────────┤
  │<────────────────────────┤                       │
  │  window.location = url  │                       │
  ├─────────────────────────────────────────────────>│
  │<──────── file stream ───────────────────────────┤
```

#### Preview (image)

Same as download but `?disposition=inline`; URL is used as `<img src>`.

#### Preview (html)

Fetched as text via `GET /files/content`, then injected into `<iframe srcDoc={content} sandbox="">`.
The empty `sandbox` attribute gives the iframe a null origin with no capabilities — blocking
scripts, same-origin access, forms, and top-level navigation. Using `srcDoc` (and not a
presigned URL) avoids the stored-XSS vector where opening such a URL in the address bar would
execute scripts on the S3 origin.

#### Preview (markdown / text)

Uses the existing `GET /files/content` (unchanged) and renders client-side.

## Backend

### New routes (`control-plane/src/routes/api/files.ts`)

```ts
// POST /bots/:botId/files/upload-url
app.post<{
  Params: { botId: string };
  Body: { key: string; contentType: string; size: number };
}>('/upload-url', async (request, reply) => {
  const { botId } = request.params;
  const { key, contentType, size } = request.body;

  if (!(await getBot(request.userId, botId))) {
    return reply.status(404).send({ error: 'Bot not found' });
  }
  if (size > 100 * 1024 * 1024) {
    return reply.status(400).send({ error: 'File too large (max 100 MB)' });
  }
  const safeKey = validateRelativeKey(key);  // reject .. segments, leading /
  const fullKey = `${request.userId}/${botId}/${safeKey}`;

  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: fullKey,
      ContentType: contentType || 'application/octet-stream',
    }),
    { expiresIn: 900 },
  );
  return { url, expiresIn: 900 };
});

// GET /bots/:botId/files/download-url?key=…&disposition=attachment|inline
app.get<{
  Params: { botId: string };
  Querystring: { key: string; disposition?: 'attachment' | 'inline' };
}>('/download-url', async (request, reply) => {
  const { botId } = request.params;
  const { key, disposition = 'attachment' } = request.query;

  if (!(await getBot(request.userId, botId))) {
    return reply.status(404).send({ error: 'Bot not found' });
  }
  const safeKey = validateRelativeKey(key);
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
    { expiresIn: 900 },
  );
  return { url, expiresIn: 900 };
});
```

### Key validator (shared helper)

```ts
function validateRelativeKey(key: string): string {
  if (!key || key.startsWith('/')) throw httpError(400, 'invalid key');
  const norm = posix.normalize(key);
  if (norm.startsWith('..') || norm.includes('/../') || norm === '..') {
    throw httpError(400, 'invalid key');
  }
  return norm;
}
```

### IAM

Control-plane task role already holds `s3:GetObject`/`ListBucket` on the data bucket.
Add `s3:PutObject` to `${dataBucket}/*` — one line in the ControlPlane stack.

Agent role untouched.

## Infrastructure (CDK)

### `infra/lib/foundation-stack.ts`

Add CORS rule to the data bucket:

```ts
dataBucket.addCorsRule({
  allowedMethods: [HttpMethods.GET, HttpMethods.PUT, HttpMethods.HEAD],
  allowedOrigins: ['*'],
  allowedHeaders: ['*'],
  exposedHeaders: ['ETag'],
  maxAge: 3000,
});
```

**Security note:** `AllowedOrigins: ['*']` is safe here because access control is
enforced by the SigV4 signature inside the presigned URL, not by CORS. CORS only
controls which browser origins may *attempt* the request.

## Frontend

### `web-console/src/lib/api.ts`

Extend the `files` object:

```ts
export const files = {
  list: ...,                                    // unchanged
  content: ...,                                 // unchanged
  uploadUrl: (botId: string, body: {
    key: string; contentType: string; size: number;
  }) =>
    request<{ url: string; expiresIn: number }>(
      `/bots/${botId}/files/upload-url`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  downloadUrl: (
    botId: string,
    key: string,
    disposition: 'attachment' | 'inline' = 'attachment',
  ) =>
    request<{ url: string; expiresIn: number }>(
      `/bots/${botId}/files/download-url?key=${encodeURIComponent(key)}` +
      `&disposition=${disposition}`,
    ),
};
```

### Dependencies

Add to `web-console/package.json`:

```
react-markdown       ^9
remark-gfm           ^4
rehype-sanitize      ^6
```

Gzipped total ≈ 30 KB.

### Component changes

#### `FileBrowser.tsx` (existing, modified)

- Tree header gains **📤 Upload** button next to the refresh icon.
- Tree panel becomes a drop zone (`onDragOver` / `onDrop`).
- The right-side `<pre>` block is extracted into a new `FilePreview.tsx`.
- New state: `selectedFolder` (last clicked folder key, defaults to `''`).
- Upload target = `selectedFolder`.

#### `FilePreview.tsx` (new)

Routes by extension:

```ts
function pickRenderer(key: string):
  'markdown' | 'html' | 'image' | 'text' | 'binary' {
  const ext = key.toLowerCase().split('.').pop() ?? '';
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['png','jpg','jpeg','gif','webp','svg','bmp'].includes(ext)) return 'image';
  if (TEXT_EXTS.includes(ext)) return 'text';
  return 'binary';
}
```

Renderers:

| Type | Data source | DOM |
|---|---|---|
| `markdown` | `/files/content` | `<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>…</ReactMarkdown>`; Source/Rendered toggle |
| `html` | `download-url?disposition=inline` | `<iframe src sandbox="allow-same-origin">`; Source/Rendered toggle (Source fetches `/files/content`) |
| `image` | `download-url?disposition=inline` | `<img src>` with max dimensions; pixel size shown in header when loaded |
| `text` | `/files/content` | existing line-numbered table |
| `binary` | — | placeholder + large Download button + size/contentType |

Header bar across all types shows: path, size, modified, Content-Type, **⬇ Download**.

#### `UploadQueue.tsx` (new)

- Lives as a floating panel anchored bottom-right of the Files tab (mounted by FileBrowser).
- Each file shows: name, size, progress bar, status, retry button on failure.
- Files are uploaded **serially** via `XMLHttpRequest` to get `upload.onprogress`.
- On completion, calls parent's `refreshFolder(prefix)` for the target folder only,
  preserving other expanded folders.
- Fades out 3 s after all items resolve.

#### `ConfirmOverwriteDialog.tsx` (new)

- Triggered when a target key exists in the current `tree` cache (or after a just-in-time
  list call for uncached folders).
- Shows old vs new size and lastModified.
- Buttons: **Overwrite** / **Skip** / **Overwrite all** / **Skip all**.

### i18n keys

Add to `web-console/src/locales/{zh,en}.json` under `botDetail.files.*`:

- `upload`, `uploadTooLarge`, `uploading`, `uploadFailed`, `retry`
- `download`, `downloadFailed`
- `dropHere`
- `overwriteTitle`, `overwriteBody`, `overwrite`, `skip`, `overwriteAll`, `skipAll`
- `preview.source`, `preview.rendered`
- `preview.noPreview`

## Error handling

| Scenario | Behavior |
|---|---|
| Presigned URL expires mid-session | S3 403 → client retries `upload-url` once; second failure → row error with Retry button |
| Network drop during PUT | XHR `error` → row status = failed + Retry; other rows unaffected |
| File > 100 MB | Rejected client-side before calling `upload-url`, red error line |
| `ContentType` mismatch vs signature | Both signing and PUT use `file.type || 'application/octet-stream'` |
| Key escape attempt (`../`, leading `/`) | Backend 400 |
| Overwrite + user selected Skip | Client records skip, never calls `upload-url` |
| Image fails to decode | `onError` → falls back to "Failed to render, download instead" |
| Download link opens inline instead of saving | Always signed with `ResponseContentDisposition=attachment; filename=…` |
| Empty or new folder after upload | `loadFolder(parentPrefix)` replaces that slice of tree |

## Testing

### Automated

`control-plane/test/routes/files.test.ts` — three new vitest cases:

1. `POST /upload-url` returns a URL when bot exists and size ≤ 100 MB.
2. `POST /upload-url` returns 400 when `key` contains `..`.
3. `POST /upload-url` returns 400 when `size > 100 * 1024 * 1024`.

Mock S3 via `aws-sdk-client-mock`, consistent with existing tests under
`control-plane/test/`.

### Manual (golden paths)

Run `npm run dev -w control-plane` + `npm run dev -w web-console`, then:

1. Upload 1 small text file → appears in tree → click to preview → shows text.
2. Upload a `.png` to existing folder → preview shows image inline.
3. Upload an `.html` file → preview renders in sandboxed iframe, inline `<script>` blocked.
4. Upload a `.md` file → rendered view shows headings/lists; toggle Source shows raw.
5. Upload a file whose key already exists → confirm dialog → Overwrite succeeds.
6. Download each file type → file lands in ~/Downloads with correct name.
7. Drag-drop 3 files onto tree panel → all 3 upload serially with progress.
8. Try a file > 100 MB → red error, no network call.

## Implementation order

One PR, roughly in this order:

1. Backend routes + `validateRelativeKey` + vitest cases.
2. CDK CORS rule + `s3:PutObject` IAM statement.
3. Frontend `api.ts` additions + npm install of the three deps.
4. Extract `FilePreview.tsx`; implement 5 renderers.
5. `FileBrowser.tsx`: upload button, drop zone, `UploadQueue`, `ConfirmOverwriteDialog`.
6. i18n strings (zh + en).
7. Manual smoke test through the golden paths above.

## Out of scope (explicit)

- Delete / rename / mkdir operations.
- Batch zip download.
- Multipart upload / resumable upload.
- Syntax highlighting for code files.
- Thumbnail generation for images.
- Access control beyond the current bot-ownership check.
