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
