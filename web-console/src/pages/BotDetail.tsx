import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { bots as botsApi, channels as channelsApi, groups as groupsApi, user as userApi, Bot, ChannelConfig, Group } from '../lib/api';

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

function getModelSelection(model: string | undefined, presets: readonly { label: string; value: string }[]): string {
  const m = model || '';
  const preset = presets.find(p => p.value === m);
  return preset ? m : (m ? 'custom' : presets[1].value);
}

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

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;
  if (!bot) return <div className="text-center py-12 text-gray-500">Bot not found</div>;

  return (
    <div className="space-y-8">
      {/* Bot info */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex justify-between items-start">
          <div>
            {editing ? (
              <div className="space-y-3">
                <input value={editName} onChange={e => setEditName(e.target.value)}
                  className="text-2xl font-bold border-b-2 border-indigo-500 focus:outline-none" />
                <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} placeholder="Description..."
                  className="block w-full text-sm border rounded-md p-2 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                <div className="flex gap-2">
                  <button onClick={saveBot} className="px-3 py-1 bg-indigo-600 text-white rounded text-sm">Save</button>
                  <button onClick={() => setEditing(false)} className="px-3 py-1 text-gray-600 text-sm">Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <h1 className="text-2xl font-bold text-gray-900">{bot.name}</h1>
                {bot.description && <p className="mt-1 text-gray-600">{bot.description}</p>}
                <p className="mt-2 text-sm text-gray-400">Trigger: {bot.triggerPattern}</p>
              </>
            )}
          </div>
          {!editing && (
            <button onClick={() => setEditing(true)} className="text-sm text-indigo-600 hover:text-indigo-500">Edit</button>
          )}
        </div>
      </div>

      {/* Model selector */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Model</h2>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
          <select
            value={provider}
            onChange={(e) => {
              const newProvider = e.target.value as 'bedrock' | 'anthropic-api';
              setProvider(newProvider);
              const presets = newProvider === 'anthropic-api' ? API_MODEL_PRESETS : BEDROCK_MODEL_PRESETS;
              setModelSelection(presets[1].value); // Default to Sonnet
              setCustomModelId('');
            }}
            className="text-sm border rounded-md p-2 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="bedrock">Bedrock</option>
            <option value="anthropic-api">Anthropic API</option>
          </select>
          {provider === 'anthropic-api' && !providerHasKey && (
            <p className="text-xs text-red-500 mt-1">
              No API key configured. <Link to="/settings" className="text-indigo-600 underline">Set up in Settings</Link>
            </p>
          )}
        </div>
        <div className="space-y-3">
          {(provider === 'anthropic-api' ? API_MODEL_PRESETS : BEDROCK_MODEL_PRESETS).map((preset) => (
            <label key={preset.value} className="flex items-center gap-3 cursor-pointer">
              <input
                type="radio"
                name="model"
                value={preset.value}
                checked={modelSelection === preset.value}
                onChange={() => setModelSelection(preset.value)}
                className="text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-sm text-gray-900">{preset.label}</span>
              <span className="text-xs text-gray-400">{preset.value}</span>
            </label>
          ))}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="radio"
              name="model"
              value="custom"
              checked={modelSelection === 'custom'}
              onChange={() => setModelSelection('custom')}
              className="text-indigo-600 focus:ring-indigo-500"
            />
            <span className="text-sm text-gray-900">Custom</span>
          </label>
          {modelSelection === 'custom' && (
            <input
              type="text"
              value={customModelId}
              onChange={(e) => setCustomModelId(e.target.value)}
              placeholder="Enter model ID..."
              className="block w-full text-sm border rounded-md p-2 focus:outline-none focus:ring-1 focus:ring-indigo-500 ml-7"
            />
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={saveModel}
              disabled={savingModel || (modelSelection === 'custom' && !customModelId.trim())}
              className="px-3 py-1 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {savingModel ? 'Saving...' : 'Save Model'}
            </button>
            {modelStatus === 'saved' && <span className="text-sm text-green-600">Saved</span>}
            {modelStatus === 'error' && <span className="text-sm text-red-600">Failed to save</span>}
          </div>
        </div>
      </div>

      {/* Channels */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">Channels</h2>
          <Link to={`/bots/${botId}/channels/new`}
            className="px-3 py-1 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700">Add Channel</Link>
        </div>
        {channelsList.length === 0 ? (
          <p className="text-gray-500 text-sm">No channels configured. Add one to start receiving messages.</p>
        ) : (
          <div className="space-y-3">
            {channelsList.map((ch) => (
              <div key={ch.channelId} className="flex justify-between items-center p-3 bg-gray-50 rounded">
                <div>
                  <span className="font-medium capitalize">{ch.channelType}</span>
                  <span className={`ml-2 px-2 py-0.5 rounded-full text-xs ${
                    ch.status === 'connected' ? 'bg-green-100 text-green-700' :
                    ch.status === 'pending_webhook' ? 'bg-yellow-100 text-yellow-700' :
                    'bg-red-100 text-red-700'
                  }`}>{ch.status === 'pending_webhook' ? 'Setup Incomplete' : ch.status}</span>
                </div>
                <div className="flex items-center gap-3">
                  {ch.status === 'pending_webhook' && (
                    <Link to={`/bots/${botId}/channels/setup?resume=${ch.channelType}`}
                      className="text-sm text-indigo-600 hover:text-indigo-500 font-medium">Resume Setup</Link>
                  )}
                  <button onClick={() => {
                    if (confirm(`Remove ${ch.channelType} channel?`)) {
                      channelsApi.delete(botId!, ch.channelType).then(loadData);
                    }
                  }}
                    className="text-sm text-red-500 hover:text-red-700">Remove</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Groups */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Groups & Conversations</h2>
        {groupsList.length === 0 ? (
          <p className="text-gray-500 text-sm">No conversations yet. Messages will appear here once users interact with your bot.</p>
        ) : (
          <div className="space-y-2">
            {groupsList.map((g) => (
              <div key={g.groupJid} className="flex justify-between items-center p-3 bg-gray-50 rounded hover:bg-gray-100">
                <Link to={`/bots/${botId}/messages/${encodeURIComponent(g.groupJid)}`} className="flex-1">
                  <div>
                    <span className="font-medium">{g.name || g.groupJid}</span>
                    <span className="ml-2 text-xs text-gray-400 capitalize">{g.channelType}</span>
                  </div>
                </Link>
                <div className="flex items-center gap-3">
                  <Link to={`/bots/${botId}/groups/${encodeURIComponent(g.groupJid)}/memory`}
                    className="text-xs text-indigo-600 hover:text-indigo-500">Memory</Link>
                  <span className="text-xs text-gray-400">{g.lastMessageAt ? new Date(g.lastMessageAt).toLocaleDateString() : ''}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick links */}
      <div className="flex gap-4">
        <Link to={`/bots/${botId}/tasks`}
          className="flex-1 p-4 bg-white rounded-lg shadow text-center hover:shadow-md transition-shadow">
          <h3 className="font-semibold text-gray-900">Scheduled Tasks</h3>
          <p className="text-sm text-gray-500 mt-1">Manage cron jobs and one-time tasks</p>
        </Link>
        <Link to={`/bots/${botId}/memory`}
          className="flex-1 p-4 bg-white rounded-lg shadow text-center hover:shadow-md transition-shadow">
          <h3 className="font-semibold text-gray-900">Bot Memory</h3>
          <p className="text-sm text-gray-500 mt-1">Edit bot-level CLAUDE.md memory</p>
        </Link>
      </div>
    </div>
  );
}
