import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { memory } from '../lib/api';

type Level = 'shared' | 'bot-global' | 'group';

export default function MemoryEditor() {
  const { botId, groupJid } = useParams<{ botId?: string; groupJid?: string }>();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Remember botId/groupJid so tab buttons stay visible when switching to /memory (shared)
  const lastBotId = useRef(botId);
  const lastGroupJid = useRef(groupJid);
  if (botId) lastBotId.current = botId;
  if (groupJid) lastGroupJid.current = groupJid;

  const level: Level = botId && groupJid ? 'group' : botId ? 'bot-global' : 'shared';

  const levelLabel = level === 'shared'
    ? 'Shared Memory'
    : level === 'bot-global'
      ? 'Bot Global Memory'
      : 'Group Memory';

  useEffect(() => { loadMemory(); }, [botId, groupJid]);

  async function loadMemory() {
    setLoading(true);
    setError('');
    try {
      let result;
      if (level === 'shared') {
        result = await memory.getShared();
      } else if (level === 'bot-global') {
        result = await memory.getBotGlobal(botId!);
      } else {
        result = await memory.getGroup(botId!, groupJid!);
      }
      setContent(result.content || '');
    } catch (err: any) {
      setError(err.message || 'Failed to load memory');
    } finally {
      setLoading(false);
    }
  }

  async function saveMemory() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      if (level === 'shared') {
        await memory.updateShared(content);
      } else if (level === 'bot-global') {
        await memory.updateBotGlobal(botId!, content);
      } else {
        await memory.updateGroup(botId!, groupJid!, content);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to save memory');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{levelLabel}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {level === 'shared' && 'Memory shared across all bots (CLAUDE.md)'}
            {level === 'bot-global' && `Bot-level memory for ${botId}`}
            {level === 'group' && `Group-level memory for ${decodeURIComponent(groupJid || '')}`}
          </p>
        </div>
        <div className="flex gap-3 items-center">
          {level === 'shared' && (
            <Link to="/" className="text-sm text-gray-500 hover:text-gray-700">Back to Dashboard</Link>
          )}
          {level !== 'shared' && (
            <Link to={`/bots/${botId}`} className="text-sm text-gray-500 hover:text-gray-700">Back to Bot</Link>
          )}
        </div>
      </div>

      <div className="flex gap-2 text-sm">
        <Link to="/memory"
          className={`px-3 py-1 rounded-full ${level === 'shared' ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
          Shared
        </Link>
        {lastBotId.current && (
          <Link to={`/bots/${lastBotId.current}/memory`}
            className={`px-3 py-1 rounded-full ${level === 'bot-global' ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            Bot Global
          </Link>
        )}
        {lastBotId.current && lastGroupJid.current && (
          <Link to={`/bots/${lastBotId.current}/groups/${lastGroupJid.current}/memory`}
            className={`px-3 py-1 rounded-full ${level === 'group' ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            Group
          </Link>
        )}
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : (
        <div className="bg-white rounded-lg shadow p-6">
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={20}
            className="w-full font-mono text-sm p-4 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 resize-y"
            placeholder="Enter memory content (CLAUDE.md format)..."
          />
          <div className="mt-4 flex items-center gap-4">
            <button
              onClick={saveMemory}
              disabled={saving}
              className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save Memory'}
            </button>
            {saved && <span className="text-sm text-green-600">Saved successfully</span>}
          </div>
        </div>
      )}
    </div>
  );
}
