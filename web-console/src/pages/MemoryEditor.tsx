import { useState, useEffect } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { Brain, Save } from 'lucide-react';
import { memory } from '../lib/api';

type Level = 'shared' | 'bot-global' | 'group';

const LEVEL_META: Record<Level, { label: string; description: string; placeholder: string }> = {
  shared: {
    label: 'Shared Memory',
    description: 'Memory shared across all bots (CLAUDE.md)',
    placeholder: '# Shared Memory\n\nEnter instructions and context shared across all your bots...',
  },
  'bot-global': {
    label: 'Bot Memory',
    description: 'Bot operating manual — identity, personality, rules, and notes (CLAUDE.md)',
    placeholder: '# Bot Memory\n\nEnter bot-specific instructions...',
  },
  group: {
    label: 'Group Memory',
    description: 'Conversation-specific memory (CLAUDE.md)',
    placeholder: '# Group Memory\n\nEnter conversation-specific context...',
  },
};

export default function MemoryEditor() {
  const { botId, groupJid } = useParams<{ botId?: string; groupJid?: string }>();
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') as Level | null;

  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Determine level from URL — standalone page is always shared;
  // bot/group memory is handled inside BotDetail tabs now.
  const level: Level = tabParam
    ? tabParam
    : botId && groupJid
      ? 'group'
      : botId
        ? 'bot-global'
        : 'shared';

  const meta = LEVEL_META[level];

  useEffect(() => { loadMemory(); }, [botId, groupJid, level]);

  async function loadMemory() {
    setLoading(true);
    setError('');
    try {
      let result;
      switch (level) {
        case 'shared':
          result = await memory.getShared();
          break;
        case 'bot-global':
          result = await memory.getBotGlobal(botId!);
          break;
        case 'group':
          if (!groupJid) { setError('Group context required'); setLoading(false); return; }
          result = await memory.getGroup(botId!, groupJid);
          break;
      }
      setContent(result.content || '');
    } catch (err: any) {
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function saveMemory() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      switch (level) {
        case 'shared':
          await memory.updateShared(content);
          break;
        case 'bot-global':
          await memory.updateBotGlobal(botId!, content);
          break;
        case 'group':
          await memory.updateGroup(botId!, groupJid || '', content);
          break;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="animate-fade-in space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-50">
            <Brain className="h-5 w-5 text-accent-600" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">{meta.label}</h1>
            <p className="text-sm text-slate-500">{meta.description}</p>
          </div>
        </div>
        {level !== 'shared' && botId && (
          <Link
            to={`/bots/${botId}`}
            className="text-sm text-slate-500 hover:text-slate-700 transition-colors"
          >
            Back to Bot
          </Link>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Empty group memory hint */}
      {!loading && level === 'group' && !content && !error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          This conversation has no independent memory yet. The bot will use its bot-level memory by default.
          Group memory is created automatically when the agent saves conversation-specific context, or you can add it manually below.
        </div>
      )}

      {/* Editor */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-accent-500 border-t-transparent" />
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={22}
            className="w-full font-mono text-sm leading-relaxed p-4 rounded-lg border border-slate-300 bg-slate-50 focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:bg-white focus:outline-none resize-y transition-colors"
            placeholder={meta.placeholder}
          />
          <div className="mt-4 flex items-center gap-4">
            <button
              onClick={saveMemory}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Save size={16} />
              {saving ? 'Saving...' : `Save ${meta.label}`}
            </button>
            {saved && (
              <span className="text-sm text-emerald-600 font-medium">Saved successfully</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
