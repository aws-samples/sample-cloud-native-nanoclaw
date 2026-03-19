import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  LayoutDashboard, Radio, MessageSquare, Clock, Brain,
  FolderOpen, Settings as SettingsIcon, Plus, Trash2, ExternalLink,
} from 'lucide-react';
import { clsx } from 'clsx';
import TabNav from '../components/TabNav';
import Badge from '../components/Badge';
import {
  bots as botsApi, channels as channelsApi, groups as groupsApi,
  user as userApi, Bot, ChannelConfig, Group,
} from '../lib/api';

/* ── Model presets ─────────────────────────────────────────────────── */

const BEDROCK_MODEL_PRESETS = [
  { label: 'Claude Haiku 4.5', value: 'global.anthropic.claude-haiku-4-5-20251001-v1:0' },
  { label: 'Claude Sonnet 4.6', value: 'global.anthropic.claude-sonnet-4-6' },
  { label: 'Claude Opus 4.6', value: 'global.anthropic.claude-opus-4-6-v1' },
] as const;

const API_MODEL_PRESETS = [
  { label: 'Claude Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
  { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
  { label: 'Claude Opus 4.6', value: 'claude-opus-4-6' },
] as const;

const DEFAULT_MODEL = 'global.anthropic.claude-sonnet-4-6';

function getModelSelection(
  model: string | undefined,
  presets: readonly { label: string; value: string }[],
): string {
  const m = model || '';
  const preset = presets.find(p => p.value === m);
  return preset ? m : (m ? 'custom' : presets[1].value);
}

/* ── Tab definitions ───────────────────────────────────────────────── */

const tabs = [
  { key: 'overview', label: 'Overview', icon: <LayoutDashboard size={16} /> },
  { key: 'channels', label: 'Channels', icon: <Radio size={16} /> },
  { key: 'conversations', label: 'Conversations', icon: <MessageSquare size={16} /> },
  { key: 'tasks', label: 'Tasks', icon: <Clock size={16} /> },
  { key: 'memory', label: 'Memory', icon: <Brain size={16} /> },
  { key: 'files', label: 'Files', icon: <FolderOpen size={16} /> },
  { key: 'settings', label: 'Settings', icon: <SettingsIcon size={16} /> },
];

/* ── Overview tab ──────────────────────────────────────────────────── */

function OverviewTab({
  bot, botId, editing, setEditing, editName, setEditName, editDesc, setEditDesc, saveBot,
  provider, setProvider, providerHasKey, modelSelection, setModelSelection,
  customModelId, setCustomModelId, saveModel, savingModel, modelStatus,
  channelCount, conversationCount,
}: {
  bot: Bot;
  botId: string;
  editing: boolean;
  setEditing: (v: boolean) => void;
  editName: string;
  setEditName: (v: string) => void;
  editDesc: string;
  setEditDesc: (v: string) => void;
  saveBot: () => void;
  provider: 'bedrock' | 'anthropic-api';
  setProvider: (v: 'bedrock' | 'anthropic-api') => void;
  providerHasKey: boolean;
  modelSelection: string;
  setModelSelection: (v: string) => void;
  customModelId: string;
  setCustomModelId: (v: string) => void;
  saveModel: () => void;
  savingModel: boolean;
  modelStatus: 'saved' | 'error' | null;
  channelCount: number;
  conversationCount: number;
}) {
  const activePresets = provider === 'anthropic-api' ? API_MODEL_PRESETS : BEDROCK_MODEL_PRESETS;

  return (
    <div className="space-y-6">
      {/* Bot info card */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-900">Bot Details</h2>
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-sm text-accent-600 hover:text-accent-700 font-medium transition-colors"
            >
              Edit
            </button>
          )}
        </div>

        {editing ? (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
              <input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
              <textarea
                value={editDesc}
                onChange={e => setEditDesc(e.target.value)}
                placeholder="Description..."
                rows={3}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none resize-none"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={saveBot}
                className="rounded-lg bg-accent-500 text-white px-4 py-2 text-sm font-medium hover:bg-accent-600 transition-colors"
              >
                Save
              </button>
              <button
                onClick={() => setEditing(false)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div>
              <span className="text-sm text-slate-500">Name</span>
              <p className="text-sm font-medium text-slate-900">{bot.name}</p>
            </div>
            {bot.description && (
              <div>
                <span className="text-sm text-slate-500">Description</span>
                <p className="text-sm text-slate-700">{bot.description}</p>
              </div>
            )}
            <div>
              <span className="text-sm text-slate-500">Trigger</span>
              <p className="text-sm font-medium text-slate-900">{bot.triggerPattern}</p>
            </div>
          </div>
        )}
      </div>

      {/* Model / Provider card */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <h2 className="text-base font-semibold text-slate-900 mb-4">Model</h2>

        {/* Provider selector */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-slate-700 mb-1">Provider</label>
          <select
            value={provider}
            onChange={(e) => {
              const newProvider = e.target.value as 'bedrock' | 'anthropic-api';
              setProvider(newProvider);
              const presets = newProvider === 'anthropic-api' ? API_MODEL_PRESETS : BEDROCK_MODEL_PRESETS;
              setModelSelection(presets[1].value);
              setCustomModelId('');
            }}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
          >
            <option value="bedrock">Bedrock</option>
            <option value="anthropic-api">Anthropic API</option>
          </select>
          {provider === 'anthropic-api' && !providerHasKey && (
            <p className="text-xs text-red-500 mt-1">
              No API key configured.{' '}
              <Link to="/settings" className="text-accent-600 underline hover:text-accent-700">
                Set up in Settings
              </Link>
            </p>
          )}
        </div>

        {/* Model radio presets */}
        <div className="space-y-3">
          {activePresets.map((preset) => (
            <label key={preset.value} className="flex items-center gap-3 cursor-pointer">
              <input
                type="radio"
                name="model"
                value={preset.value}
                checked={modelSelection === preset.value}
                onChange={() => setModelSelection(preset.value)}
                className="text-accent-500 focus:ring-accent-500"
              />
              <span className="text-sm text-slate-900">{preset.label}</span>
              <span className="text-xs text-slate-400 font-mono">{preset.value}</span>
            </label>
          ))}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="radio"
              name="model"
              value="custom"
              checked={modelSelection === 'custom'}
              onChange={() => setModelSelection('custom')}
              className="text-accent-500 focus:ring-accent-500"
            />
            <span className="text-sm text-slate-900">Custom</span>
          </label>
          {modelSelection === 'custom' && (
            <input
              type="text"
              value={customModelId}
              onChange={(e) => setCustomModelId(e.target.value)}
              placeholder="Enter model ID..."
              className="block w-full ml-7 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
            />
          )}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={saveModel}
              disabled={savingModel || (modelSelection === 'custom' && !customModelId.trim())}
              className="rounded-lg bg-accent-500 text-white px-4 py-2 text-sm font-medium hover:bg-accent-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {savingModel ? 'Saving...' : 'Save Model'}
            </button>
            {modelStatus === 'saved' && <span className="text-sm text-emerald-600">Saved</span>}
            {modelStatus === 'error' && <span className="text-sm text-red-600">Failed to save</span>}
          </div>
        </div>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 text-center">
          <p className="text-2xl font-semibold text-slate-900">{channelCount}</p>
          <p className="text-sm text-slate-500 mt-1">Channels</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 text-center">
          <p className="text-2xl font-semibold text-slate-900">{conversationCount}</p>
          <p className="text-sm text-slate-500 mt-1">Conversations</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 text-center">
          <p className="text-2xl font-semibold text-slate-900">--</p>
          <p className="text-sm text-slate-500 mt-1">Tasks</p>
        </div>
      </div>
    </div>
  );
}

/* ── Channels tab ──────────────────────────────────────────────────── */

function ChannelsTab({
  botId, channelsList, loadData,
}: {
  botId: string;
  channelsList: ChannelConfig[];
  loadData: () => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {channelsList.map((ch) => (
        <div key={ch.channelId} className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-900 capitalize">{ch.channelType}</h3>
              <Badge
                variant={
                  ch.status === 'connected' ? 'success' :
                  ch.status === 'pending_webhook' ? 'warning' : 'error'
                }
              >
                {ch.status === 'pending_webhook' ? 'Setup Incomplete' : ch.status}
              </Badge>
            </div>
            {ch.status === 'pending_webhook' && (
              <Link
                to={`/bots/${botId}/channels/setup?resume=${ch.channelType}`}
                className="inline-flex items-center gap-1 text-sm text-accent-600 hover:text-accent-700 font-medium"
              >
                Resume Setup <ExternalLink size={14} />
              </Link>
            )}
          </div>
          <div className="mt-4 pt-3 border-t border-slate-100">
            <button
              onClick={() => {
                if (confirm(`Remove ${ch.channelType} channel?`)) {
                  channelsApi.delete(botId, ch.channelType).then(loadData);
                }
              }}
              className="inline-flex items-center gap-1.5 text-red-500 hover:text-red-700 text-sm transition-colors"
            >
              <Trash2 size={14} /> Remove
            </button>
          </div>
        </div>
      ))}

      {/* Add channel card */}
      <Link
        to={`/bots/${botId}/channels/new`}
        className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 p-5 text-slate-400 hover:border-accent-400 hover:text-accent-500 transition-colors min-h-[120px]"
      >
        <Plus size={24} />
        <span className="text-sm font-medium mt-2">Add Channel</span>
      </Link>
    </div>
  );
}

/* ── Conversations tab ─────────────────────────────────────────────── */

function ConversationsTab({
  botId, groupsList,
}: {
  botId: string;
  groupsList: Group[];
}) {
  if (groupsList.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 text-center">
        <MessageSquare size={32} className="mx-auto text-slate-300 mb-3" />
        <p className="text-sm text-slate-500">
          No conversations yet. Messages will appear here once users interact with your bot.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            <th className="text-left px-5 py-3 font-medium text-slate-600">Name</th>
            <th className="text-left px-5 py-3 font-medium text-slate-600">Channel</th>
            <th className="text-left px-5 py-3 font-medium text-slate-600">Last Active</th>
            <th className="text-right px-5 py-3 font-medium text-slate-600">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {groupsList.map((g) => (
            <tr key={g.groupJid} className="hover:bg-slate-50 transition-colors">
              <td className="px-5 py-3">
                <Link
                  to={`/bots/${botId}/messages/${encodeURIComponent(g.groupJid)}`}
                  className="font-medium text-slate-900 hover:text-accent-600 transition-colors"
                >
                  {g.name || g.groupJid}
                </Link>
              </td>
              <td className="px-5 py-3">
                <Badge variant="info">{g.channelType}</Badge>
              </td>
              <td className="px-5 py-3 text-slate-500">
                {g.lastMessageAt ? new Date(g.lastMessageAt).toLocaleDateString() : '--'}
              </td>
              <td className="px-5 py-3 text-right">
                <Link
                  to={`/bots/${botId}/groups/${encodeURIComponent(g.groupJid)}/memory`}
                  className="text-accent-600 hover:text-accent-700 font-medium transition-colors"
                >
                  Memory
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Main component ────────────────────────────────────────────────── */

export default function BotDetail() {
  const { botId } = useParams<{ botId: string }>();
  const [bot, setBot] = useState<Bot | null>(null);
  const [channelsList, setChannels] = useState<ChannelConfig[]>([]);
  const [groupsList, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [modelSelection, setModelSelection] = useState<string>('');
  const [customModelId, setCustomModelId] = useState('');
  const [savingModel, setSavingModel] = useState(false);
  const [modelStatus, setModelStatus] = useState<'saved' | 'error' | null>(null);
  const [provider, setProvider] = useState<'bedrock' | 'anthropic-api'>('bedrock');
  const [providerHasKey, setProviderHasKey] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => { if (botId) loadData(); }, [botId]);

  async function loadData() {
    try {
      const [botData, chs, grps, providerConfig] = await Promise.all([
        botsApi.get(botId!),
        channelsApi.list(botId!),
        groupsApi.list(botId!),
        userApi.getProvider(),
      ]);
      setBot(botData);
      setChannels(chs);
      setGroups(grps);
      setEditName(botData.name);
      setEditDesc(botData.description || '');
      setProviderHasKey(providerConfig.hasApiKey);
      const botProvider = botData.modelProvider || 'bedrock';
      setProvider(botProvider);
      const activePresets = botProvider === 'anthropic-api' ? API_MODEL_PRESETS : BEDROCK_MODEL_PRESETS;
      setModelSelection(getModelSelection(botData.model, activePresets));
      setCustomModelId(
        activePresets.find(p => p.value === botData.model) ? '' : (botData.model || '')
      );
    } catch (err) {
      console.error('Failed to load bot:', err);
    } finally {
      setLoading(false);
    }
  }

  async function saveBot() {
    await botsApi.update(botId!, { name: editName, description: editDesc });
    setEditing(false);
    loadData();
  }

  async function saveModel() {
    const model = modelSelection === 'custom' ? customModelId.trim() : modelSelection;
    if (!model) return;
    setSavingModel(true);
    setModelStatus(null);
    try {
      await botsApi.update(botId!, { model, modelProvider: provider });
      setModelStatus('saved');
      setTimeout(() => setModelStatus(null), 2000);
      loadData();
    } catch (err) {
      console.error('Failed to save model:', err);
      setModelStatus('error');
    } finally {
      setSavingModel(false);
    }
  }

  if (loading) return <div className="text-center py-12 text-slate-500">Loading...</div>;
  if (!bot) return <div className="text-center py-12 text-slate-500">Bot not found</div>;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{bot.name}</h1>
          {bot.description && <p className="text-sm text-slate-500 mt-1">{bot.description}</p>}
        </div>
        <Badge variant={bot.status === 'active' ? 'success' : 'neutral'}>{bot.status}</Badge>
      </div>

      {/* Tabs */}
      <TabNav tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

      {/* Tab content */}
      <div className="mt-6">
        {activeTab === 'overview' && (
          <OverviewTab
            bot={bot}
            botId={botId!}
            editing={editing}
            setEditing={setEditing}
            editName={editName}
            setEditName={setEditName}
            editDesc={editDesc}
            setEditDesc={setEditDesc}
            saveBot={saveBot}
            provider={provider}
            setProvider={setProvider}
            providerHasKey={providerHasKey}
            modelSelection={modelSelection}
            setModelSelection={setModelSelection}
            customModelId={customModelId}
            setCustomModelId={setCustomModelId}
            saveModel={saveModel}
            savingModel={savingModel}
            modelStatus={modelStatus}
            channelCount={channelsList.length}
            conversationCount={groupsList.length}
          />
        )}
        {activeTab === 'channels' && (
          <ChannelsTab botId={botId!} channelsList={channelsList} loadData={loadData} />
        )}
        {activeTab === 'conversations' && (
          <ConversationsTab botId={botId!} groupsList={groupsList} />
        )}
        {activeTab === 'tasks' && (
          <div className="text-slate-500 text-sm">Tasks tab — coming soon</div>
        )}
        {activeTab === 'memory' && (
          <div className="text-slate-500 text-sm">Memory tab — coming soon</div>
        )}
        {activeTab === 'files' && (
          <div className="text-slate-500 text-sm">Files tab — coming soon</div>
        )}
        {activeTab === 'settings' && (
          <div className="text-slate-500 text-sm">Settings tab — coming soon</div>
        )}
      </div>
    </div>
  );
}
