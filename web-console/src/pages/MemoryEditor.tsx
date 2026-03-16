import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { memory } from '../lib/api';

type Level = 'shared' | 'bot-global' | 'group' | 'persona' | 'bootstrap' | 'user-context';

const LEVEL_META: Record<Level, { label: string; description: string; placeholder: string }> = {
  shared: {
    label: 'Shared Memory',
    description: 'Memory shared across all bots (CLAUDE.md)',
    placeholder: 'Enter shared memory content...',
  },
  'bot-global': {
    label: 'Bot Memory',
    description: 'Bot-level persistent memory (CLAUDE.md)',
    placeholder: 'Enter bot memory content...',
  },
  group: {
    label: 'Group Memory',
    description: 'Conversation-specific memory (CLAUDE.md)',
    placeholder: 'Enter group memory content...',
  },
  persona: {
    label: 'Persona',
    description: 'Bot identity and tone (PERSONA.md) — defines who the bot is and how it speaks',
    placeholder: '# Identity\nYou are Luna, a friendly customer support agent for Acme Corp.\n\n# Tone\n- Speak warmly and professionally\n- Use simple language\n- Be concise but thorough',
  },
  bootstrap: {
    label: 'Bootstrap',
    description: 'First-session instructions (BOOTSTRAP.md) — only injected when starting a new conversation',
    placeholder: '# First Contact\n- Greet the user and introduce yourself\n- Ask what they need help with\n- Explain your capabilities briefly',
  },
  'user-context': {
    label: 'User Context',
    description: 'About the humans in this conversation (USER.md)',
    placeholder: '# Users\n- Alice: Product manager, prefers concise answers\n- Bob: New engineer, needs detailed explanations',
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

  // Remember botId/groupJid so tab buttons stay visible when switching
  const lastBotId = useRef(botId);
  const lastGroupJid = useRef(groupJid);
  if (botId) lastBotId.current = botId;
  if (groupJid) lastGroupJid.current = groupJid;

  // Determine level from URL
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
        case 'persona':
          result = await memory.getPersona(botId!);
          break;
        case 'bootstrap':
          result = await memory.getBootstrap(botId!);
          break;
        case 'user-context':
          if (!groupJid) { setError('Group context required for User Context'); setLoading(false); return; }
          result = await memory.getUserContext(botId!, groupJid);
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
        case 'persona':
          await memory.updatePersona(botId!, content);
          break;
        case 'bootstrap':
          await memory.updateBootstrap(botId!, content);
          break;
        case 'user-context':
          await memory.updateUserContext(botId!, groupJid || '', content);
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

  // Build tab list based on context
  const tabs: { level: Level; to: string }[] = [];
  tabs.push({ level: 'shared', to: '/memory' });
  if (lastBotId.current) {
    tabs.push({ level: 'persona', to: `/bots/${lastBotId.current}/memory?tab=persona` });
    tabs.push({ level: 'bootstrap', to: `/bots/${lastBotId.current}/memory?tab=bootstrap` });
    tabs.push({ level: 'bot-global', to: `/bots/${lastBotId.current}/memory` });
  }
  if (lastBotId.current && lastGroupJid.current) {
    tabs.push({ level: 'group', to: `/bots/${lastBotId.current}/groups/${lastGroupJid.current}/memory` });
    tabs.push({ level: 'user-context', to: `/bots/${lastBotId.current}/groups/${lastGroupJid.current}/memory?tab=user-context` });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{meta.label}</h1>
          <p className="mt-1 text-sm text-gray-500">{meta.description}</p>
        </div>
        <div className="flex gap-3 items-center">
          {level === 'shared' && (
            <Link to="/" className="text-sm text-gray-500 hover:text-gray-700">Back to Dashboard</Link>
          )}
          {level !== 'shared' && (
            <Link to={`/bots/${botId || lastBotId.current}`} className="text-sm text-gray-500 hover:text-gray-700">Back to Bot</Link>
          )}
        </div>
      </div>

      <div className="flex gap-2 text-sm flex-wrap">
        {tabs.map((tab) => (
          <Link key={tab.level} to={tab.to}
            className={`px-3 py-1 rounded-full ${
              level === tab.level
                ? 'bg-indigo-100 text-indigo-700'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}>
            {LEVEL_META[tab.level].label}
          </Link>
        ))}
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
            placeholder={meta.placeholder}
          />
          <div className="mt-4 flex items-center gap-4">
            <button
              onClick={saveMemory}
              disabled={saving}
              className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : `Save ${meta.label}`}
            </button>
            {saved && <span className="text-sm text-green-600">Saved successfully</span>}
          </div>
        </div>
      )}
    </div>
  );
}
