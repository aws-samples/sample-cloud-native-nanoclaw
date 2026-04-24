import { useEffect, useRef, useState } from 'react';
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

  // Capture latest onDismiss in a ref so the auto-hide effect doesn't re-run
  // every time the parent re-renders with a fresh inline callback.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => { onDismissRef.current = onDismiss; }, [onDismiss]);

  // Re-show when a new batch of uploads arrives after a previous auto-hide.
  useEffect(() => {
    if (items.length > 0) setHidden(false);
  }, [items.length]);

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
      onDismissRef.current();
    }, 3000);
    return () => clearTimeout(timer);
  }, [items]);

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
