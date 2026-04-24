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
          // Both Source and Rendered modes use the text content: rendered
          // mode puts it into an iframe via srcDoc with a null-origin sandbox,
          // avoiding an XSS vector on the S3 origin (a presigned URL for an
          // HTML file could otherwise execute scripts if pasted into the
          // address bar).
          const c = await filesApi.content(botId, fileKey);
          if (!cancelled) setTextContent(c);
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

        {renderer === 'html' && textContent && (
          viewMode === 'rendered' ? (
            <iframe
              srcDoc={textContent.content}
              sandbox=""
              className="w-full h-full border-0"
              title={fileKey}
            />
          ) : (
            <TextView content={textContent.content} />
          )
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
                {line || ' '}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </pre>
  );
}
