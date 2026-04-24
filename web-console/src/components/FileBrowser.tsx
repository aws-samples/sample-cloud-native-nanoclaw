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
