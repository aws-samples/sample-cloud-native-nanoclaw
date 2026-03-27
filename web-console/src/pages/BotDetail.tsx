import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard, Radio, MessageSquare, Clock, Brain,
  FolderOpen, Settings as SettingsIcon, Plus, Trash2, ExternalLink,
  Play, Pause, Save, AlertTriangle, Shield, Zap,
} from 'lucide-react';
import { clsx } from 'clsx';
import TabNav from '../components/TabNav';
import Badge from '../components/Badge';
import FileBrowser from '../components/FileBrowser';
import {
  bots as botsApi, channels as channelsApi, groups as groupsApi,
  tasks as tasksApi, memory as memoryApi,
  providers as providersApi,
  Bot, ChannelConfig, Group, ScheduledTask,
  type ProviderPublic,
  type AvailableTools, type ToolWhitelistConfig,
  type BotSkillEntry,
} from '../lib/api';

/* ── Tab icon map (labels are i18n'd inside BotDetail) ─────────────── */

const tabIcons: Record<string, React.ReactNode> = {
  overview: <LayoutDashboard size={16} />,
  channels: <Radio size={16} />,
  conversations: <MessageSquare size={16} />,
  tasks: <Clock size={16} />,
  memory: <Brain size={16} />,
  files: <FolderOpen size={16} />,
  tools: <Shield size={16} />,
  skills: <Zap size={16} />,
  settings: <SettingsIcon size={16} />,
};

/* ── Overview tab ──────────────────────────────────────────────────── */

function OverviewTab({
  bot, botId, editing, setEditing, editName, setEditName, editDesc, setEditDesc, saveBot,
  providersList, selectedProviderId, setSelectedProviderId,
  selectedModelId, setSelectedModelId, saveModel, savingModel, modelStatus,
  channelCount, conversationCount, taskCount,
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
  providersList: ProviderPublic[];
  selectedProviderId: string;
  setSelectedProviderId: (v: string) => void;
  selectedModelId: string;
  setSelectedModelId: (v: string) => void;
  saveModel: () => void;
  savingModel: boolean;
  modelStatus: 'saved' | 'error' | null;
  channelCount: number;
  conversationCount: number;
  taskCount: number;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      {/* Bot info card */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-900">{t('botDetail.overview.botDetails')}</h2>
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-sm text-accent-600 hover:text-accent-700 font-medium transition-colors"
            >
              {t('common.edit')}
            </button>
          )}
        </div>

        {editing ? (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('botDetail.overview.name')}</label>
              <input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('botDetail.overview.description')}</label>
              <textarea
                value={editDesc}
                onChange={e => setEditDesc(e.target.value)}
                placeholder={t('botDetail.overview.descriptionPlaceholder')}
                rows={3}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none resize-none"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={saveBot}
                className="rounded-lg bg-accent-500 text-white px-4 py-2 text-sm font-medium hover:bg-accent-600 transition-colors"
              >
                {t('common.save')}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div>
              <span className="text-sm text-slate-500">{t('botDetail.overview.name')}</span>
              <p className="text-sm font-medium text-slate-900">{bot.name}</p>
            </div>
            {bot.description && (
              <div>
                <span className="text-sm text-slate-500">{t('botDetail.overview.description')}</span>
                <p className="text-sm text-slate-700">{bot.description}</p>
              </div>
            )}
            <div>
              <span className="text-sm text-slate-500">{t('botDetail.overview.trigger')}</span>
              <p className="text-sm font-medium text-slate-900">{bot.triggerPattern}</p>
            </div>
          </div>
        )}
      </div>

      {/* Model / Provider card */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <h2 className="text-base font-semibold text-slate-900 mb-4">{t('botDetail.overview.model')}</h2>

        {providersList.length === 0 ? (
          <div className="text-sm text-slate-500 py-4">
            {t('botDetail.overview.noProviders')}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Provider dropdown */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('botDetail.overview.provider')}</label>
              <select
                value={selectedProviderId}
                onChange={(e) => {
                  const newId = e.target.value;
                  setSelectedProviderId(newId);
                  const prov = providersList.find(p => p.providerId === newId);
                  setSelectedModelId(prov?.modelIds[0] || '');
                }}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              >
                {providersList.map(p => (
                  <option key={p.providerId} value={p.providerId}>
                    {p.providerName} ({p.providerType === 'bedrock' ? t('botDetail.overview.bedrock') : t('botDetail.overview.anthropicApi')})
                  </option>
                ))}
              </select>
            </div>

            {/* Model dropdown */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('botDetail.overview.model')}</label>
              <select
                value={selectedModelId}
                onChange={(e) => setSelectedModelId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              >
                {(providersList.find(p => p.providerId === selectedProviderId)?.modelIds || []).map(mid => (
                  <option key={mid} value={mid}>{mid}</option>
                ))}
              </select>
            </div>

            {/* Save button */}
            <div className="flex items-center gap-3">
              <button
                onClick={saveModel}
                disabled={savingModel || !selectedProviderId || !selectedModelId}
                className="rounded-lg bg-accent-500 text-white px-4 py-2 text-sm font-medium hover:bg-accent-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingModel ? t('common.saving') : t('botDetail.overview.saveModel')}
              </button>
              {modelStatus === 'saved' && <span className="text-sm text-emerald-600">{t('common.saved')}</span>}
              {modelStatus === 'error' && <span className="text-sm text-red-600">{t('common.failedToSave')}</span>}
            </div>
          </div>
        )}
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 text-center">
          <p className="text-2xl font-semibold text-slate-900">{channelCount}</p>
          <p className="text-sm text-slate-500 mt-1">{t('botDetail.overview.channels')}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 text-center">
          <p className="text-2xl font-semibold text-slate-900">{conversationCount}</p>
          <p className="text-sm text-slate-500 mt-1">{t('botDetail.overview.conversations')}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 text-center">
          <p className="text-2xl font-semibold text-slate-900">{taskCount}</p>
          <p className="text-sm text-slate-500 mt-1">{t('botDetail.overview.tasks')}</p>
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
  const { t } = useTranslation();

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
                {ch.status === 'pending_webhook' ? t('botDetail.channels.setupIncomplete') : ch.status}
              </Badge>
            </div>
            {ch.status === 'pending_webhook' && (
              <Link
                to={`/bots/${botId}/channels/setup?resume=${ch.channelType}`}
                className="inline-flex items-center gap-1 text-sm text-accent-600 hover:text-accent-700 font-medium"
              >
                {t('botDetail.channels.resumeSetup')} <ExternalLink size={14} />
              </Link>
            )}
          </div>
          <div className="mt-4 pt-3 border-t border-slate-100">
            <button
              onClick={() => {
                if (confirm(t('botDetail.channels.removeConfirm', { channelType: ch.channelType }))) {
                  channelsApi.delete(botId, ch.channelType).then(loadData);
                }
              }}
              className="inline-flex items-center gap-1.5 text-red-500 hover:text-red-700 text-sm transition-colors"
            >
              <Trash2 size={14} /> {t('common.remove')}
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
        <span className="text-sm font-medium mt-2">{t('botDetail.channels.addChannel')}</span>
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
  const { t } = useTranslation();

  if (groupsList.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 text-center">
        <MessageSquare size={32} className="mx-auto text-slate-300 mb-3" />
        <p className="text-sm text-slate-500">
          {t('botDetail.conversations.noConversations')}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            <th className="text-left px-5 py-3 font-medium text-slate-600">{t('botDetail.conversations.name')}</th>
            <th className="text-left px-5 py-3 font-medium text-slate-600">{t('botDetail.conversations.channel')}</th>
            <th className="text-left px-5 py-3 font-medium text-slate-600">{t('botDetail.conversations.lastActive')}</th>
            <th className="text-right px-5 py-3 font-medium text-slate-600">{t('botDetail.conversations.actions')}</th>
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
                  {t('botDetail.conversations.memory')}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Tasks tab ────────────────────────────────────────────────────── */

function TasksTab({
  botId, tasksList, loadData,
}: {
  botId: string;
  tasksList: ScheduledTask[];
  loadData: () => void;
}) {
  const { t } = useTranslation();
  const [showCreate, setShowCreate] = useState(false);
  const [newTask, setNewTask] = useState({ groupJid: '', prompt: '', scheduleType: 'cron', scheduleValue: '' });
  const [creating, setCreating] = useState(false);

  async function createTask() {
    setCreating(true);
    try {
      await tasksApi.create(botId, newTask);
      setShowCreate(false);
      setNewTask({ groupJid: '', prompt: '', scheduleType: 'cron', scheduleValue: '' });
      loadData();
    } catch (err) {
      console.error('Failed to create task:', err);
    } finally {
      setCreating(false);
    }
  }

  async function toggleTask(taskId: string, currentStatus: string) {
    const newStatus = currentStatus === 'active' ? 'paused' : 'active';
    await tasksApi.update(botId, taskId, { status: newStatus });
    loadData();
  }

  async function deleteTask(taskId: string) {
    if (!confirm(t('botDetail.tasks.deleteConfirm'))) return;
    await tasksApi.delete(botId, taskId);
    loadData();
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-slate-500">{t('botDetail.tasks.scheduledTasks', { count: tasksList.length })}</p>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent-500 text-white px-4 py-2 text-sm font-medium hover:bg-accent-600 transition-colors"
        >
          <Plus size={16} /> {t('botDetail.tasks.newTask')}
        </button>
      </div>

      {/* Create task form */}
      {showCreate && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t('botDetail.tasks.groupJid')}</label>
            <input
              placeholder={t('botDetail.tasks.groupJidPlaceholder')}
              value={newTask.groupJid}
              onChange={e => setNewTask(prev => ({ ...prev, groupJid: e.target.value }))}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t('botDetail.tasks.prompt')}</label>
            <textarea
              placeholder={t('botDetail.tasks.promptPlaceholder')}
              value={newTask.prompt}
              onChange={e => setNewTask(prev => ({ ...prev, prompt: e.target.value }))}
              rows={3}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none resize-none"
            />
          </div>
          <div className="flex gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('botDetail.tasks.scheduleType')}</label>
              <select
                value={newTask.scheduleType}
                onChange={e => setNewTask(prev => ({ ...prev, scheduleType: e.target.value }))}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              >
                <option value="cron">{t('botDetail.tasks.cronType')}</option>
                <option value="interval">{t('botDetail.tasks.intervalType')}</option>
                <option value="once">{t('botDetail.tasks.onceType')}</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('botDetail.tasks.scheduleValue')}</label>
              <input
                placeholder={newTask.scheduleType === 'cron' ? '0 9 * * *' : newTask.scheduleType === 'interval' ? '3600000' : '2025-01-01T09:00:00Z'}
                value={newTask.scheduleValue}
                onChange={e => setNewTask(prev => ({ ...prev, scheduleValue: e.target.value }))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={createTask}
              disabled={creating || !newTask.groupJid.trim() || !newTask.prompt.trim() || !newTask.scheduleValue.trim()}
              className="rounded-lg bg-accent-500 text-white px-4 py-2 text-sm font-medium hover:bg-accent-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? t('common.creating') : t('botDetail.tasks.createTask')}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Task list */}
      {tasksList.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 text-center">
          <Clock size={32} className="mx-auto text-slate-300 mb-3" />
          <p className="text-sm text-slate-500">
            {t('botDetail.tasks.noTasks')}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {tasksList.map((task) => (
            <div key={task.taskId} className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
              <div className="flex justify-between items-start">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-900 truncate">
                    {task.prompt.length > 100 ? task.prompt.slice(0, 100) + '...' : task.prompt}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    {task.scheduleType}: <span className="font-mono">{task.scheduleValue}</span>
                    {' '}&middot;{' '}{t('botDetail.tasks.group')}: {task.groupJid}
                  </p>
                  {task.nextRun && (
                    <p className="text-xs text-slate-400 mt-1">
                      {t('botDetail.tasks.nextRun', { time: new Date(task.nextRun).toLocaleString() })}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-4 shrink-0">
                  <Badge
                    variant={
                      task.status === 'active' ? 'success' :
                      task.status === 'paused' ? 'warning' : 'neutral'
                    }
                  >
                    {task.status}
                  </Badge>
                  <button
                    onClick={() => toggleTask(task.taskId, task.status)}
                    className="inline-flex items-center gap-1 text-sm text-accent-600 hover:text-accent-700 font-medium transition-colors"
                    title={task.status === 'active' ? t('botDetail.tasks.pause') : t('botDetail.tasks.resume')}
                  >
                    {task.status === 'active' ? <Pause size={14} /> : <Play size={14} />}
                    {task.status === 'active' ? t('botDetail.tasks.pause') : t('botDetail.tasks.resume')}
                  </button>
                  <button
                    onClick={() => deleteTask(task.taskId)}
                    className="inline-flex items-center gap-1 text-sm text-red-500 hover:text-red-700 transition-colors"
                  >
                    <Trash2 size={14} /> {t('common.delete')}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Memory tab ───────────────────────────────────────────────────── */

function MemoryTab({ botId }: { botId: string }) {
  const { t } = useTranslation();
  const [memoryTab, setMemoryTab] = useState<'bot' | 'shared'>('bot');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);

  useEffect(() => { loadMemory(); }, [memoryTab, botId]);

  async function loadMemory() {
    setLoading(true);
    setStatus(null);
    try {
      const result = memoryTab === 'bot'
        ? await memoryApi.getBotGlobal(botId)
        : await memoryApi.getShared();
      setContent(result.content || '');
    } catch (err) {
      console.error('Failed to load memory:', err);
      setContent('');
    } finally {
      setLoading(false);
    }
  }

  async function saveMemory() {
    setSaving(true);
    setStatus(null);
    try {
      if (memoryTab === 'bot') {
        await memoryApi.updateBotGlobal(botId, content);
      } else {
        await memoryApi.updateShared(content);
      }
      setStatus('saved');
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      console.error('Failed to save memory:', err);
      setStatus('error');
    } finally {
      setSaving(false);
    }
  }

  const tabMeta = {
    bot: {
      label: t('botDetail.memory.botMemory'),
      description: t('botDetail.memory.botMemoryDesc'),
      placeholder: t('botDetail.memory.botMemoryPlaceholder'),
      saveLabel: t('botDetail.memory.saveBotMemory'),
    },
    shared: {
      label: t('botDetail.memory.sharedMemory'),
      description: t('botDetail.memory.sharedMemoryDesc'),
      placeholder: t('botDetail.memory.sharedMemoryPlaceholder'),
      saveLabel: t('botDetail.memory.saveSharedMemory'),
    },
  };
  const meta = tabMeta[memoryTab];

  return (
    <div className="space-y-4">
      {/* Sub-tabs */}
      <div className="flex gap-2">
        {(['bot', 'shared'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setMemoryTab(tab)}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
              memoryTab === tab
                ? 'bg-accent-500 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
            )}
          >
            {tabMeta[tab].label}
          </button>
        ))}
      </div>

      <p className="text-sm text-slate-500">{meta.description}</p>

      {loading ? (
        <div className="text-center py-12 text-slate-500 text-sm">{t('common.loading')}</div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={20}
            placeholder={meta.placeholder}
            className="w-full font-mono text-sm p-4 border border-slate-300 rounded-lg focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none resize-y"
          />
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={saveMemory}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-500 text-white px-4 py-2 text-sm font-medium hover:bg-accent-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save size={16} /> {saving ? t('common.saving') : meta.saveLabel}
            </button>
            {status === 'saved' && <span className="text-sm text-emerald-600">{t('common.savedSuccessfully')}</span>}
            {status === 'error' && <span className="text-sm text-red-600">{t('common.failedToSave')}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Tools tab ────────────────────────────────────────────────────── */

function ToolsTab({
  bot, botId, loadData,
}: {
  bot: Bot;
  botId: string;
  loadData: () => void;
}) {
  const { t } = useTranslation();
  const [mcpToolsEnabled, setMcpToolsEnabled] = useState(bot.toolWhitelist?.mcpToolsEnabled ?? false);
  const [allowedMcpTools, setAllowedMcpTools] = useState<string[]>(bot.toolWhitelist?.allowedMcpTools ?? []);
  const [catalog, setCatalog] = useState<AvailableTools | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);

  useEffect(() => {
    botsApi.availableTools().then(setCatalog).catch(console.error);
  }, []);

  useEffect(() => {
    setMcpToolsEnabled(bot.toolWhitelist?.mcpToolsEnabled ?? false);
    setAllowedMcpTools(bot.toolWhitelist?.allowedMcpTools ?? []);
  }, [bot.toolWhitelist]);

  function toggleMcpTool(name: string) {
    setAllowedMcpTools(prev =>
      prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]
    );
  }

  async function saveWhitelist() {
    setSaving(true);
    setStatus(null);
    try {
      const toolWhitelist: ToolWhitelistConfig = {
        mcpToolsEnabled,
        skillsEnabled: bot.toolWhitelist?.skillsEnabled ?? false,
        allowedMcpTools,
        allowedSkills: bot.toolWhitelist?.allowedSkills ?? [],
      };
      await botsApi.update(botId, { toolWhitelist } as Partial<Bot>);
      setStatus('saved');
      setTimeout(() => setStatus(null), 3000);
      loadData();
    } catch {
      setStatus('error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Description */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <h2 className="text-base font-semibold text-slate-900">{t('botDetail.tools.title')}</h2>
        <p className="text-sm text-slate-500 mt-1">{t('botDetail.tools.description')}</p>
      </div>

      {/* MCP Tools — with its own toggle */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-900">{t('botDetail.tools.mcpTools')}</h3>
          <button
            onClick={() => setMcpToolsEnabled(!mcpToolsEnabled)}
            className={clsx(
              'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
              mcpToolsEnabled ? 'bg-accent-500' : 'bg-slate-300',
            )}
          >
            <span className={clsx('inline-block h-4 w-4 rounded-full bg-white transition-transform', mcpToolsEnabled ? 'translate-x-6' : 'translate-x-1')} />
          </button>
        </div>
        <p className="text-xs text-slate-400 mb-3">
          {mcpToolsEnabled ? t('botDetail.tools.mcpToolsEnabled') : t('botDetail.tools.mcpToolsDisabled')}
        </p>
        <div className={clsx('grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3', !mcpToolsEnabled && 'opacity-50 pointer-events-none')}>
          {catalog?.mcpTools.map(tool => (
            <label key={tool.name} className="flex items-center gap-2 cursor-pointer" title={tool.description}>
              <input
                type="checkbox"
                checked={allowedMcpTools.includes(tool.name)}
                onChange={() => toggleMcpTool(tool.name)}
                className="rounded border-slate-300 text-accent-500 focus:ring-accent-500"
              />
              <span className="text-sm text-slate-700 font-mono">{tool.name}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Save button */}
      <div className="flex items-center gap-3">
        <button
          onClick={saveWhitelist}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent-500 text-white px-5 py-2.5 text-sm font-medium hover:bg-accent-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Save size={16} /> {saving ? t('botDetail.tools.saving') : t('botDetail.tools.save')}
        </button>
        {status === 'saved' && <span className="text-sm text-emerald-600">{t('botDetail.tools.saved')}</span>}
        {status === 'error' && <span className="text-sm text-red-600">{t('botDetail.tools.error')}</span>}
      </div>
    </div>
  );
}

/* ── Settings tab ─────────────────────────────────────────────────── */

function SettingsTab({
  bot, botId, loadData,
}: {
  bot: Bot;
  botId: string;
  loadData: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [trigger, setTrigger] = useState(bot.triggerPattern);
  const [savingTrigger, setSavingTrigger] = useState(false);
  const [triggerStatus, setTriggerStatus] = useState<'saved' | 'error' | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function saveTrigger() {
    setSavingTrigger(true);
    setTriggerStatus(null);
    try {
      await botsApi.update(botId, { triggerPattern: trigger });
      setTriggerStatus('saved');
      setTimeout(() => setTriggerStatus(null), 2000);
      loadData();
    } catch (err) {
      console.error('Failed to save trigger:', err);
      setTriggerStatus('error');
    } finally {
      setSavingTrigger(false);
    }
  }

  async function deleteBot() {
    if (!window.confirm(t('botDetail.settings.deleteBotConfirm', { name: bot.name }))) return;
    setDeleting(true);
    try {
      await botsApi.delete(botId);
      navigate('/');
    } catch (err) {
      console.error('Failed to delete bot:', err);
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Trigger pattern */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <h2 className="text-base font-semibold text-slate-900 mb-1">{t('botDetail.settings.triggerPattern')}</h2>
        <p className="text-sm text-slate-500 mb-4">
          {t('botDetail.settings.triggerDesc')}
        </p>
        <div className="flex gap-3 items-start">
          <input
            value={trigger}
            onChange={e => setTrigger(e.target.value)}
            placeholder={t('botDetail.settings.triggerPlaceholder')}
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
          />
          <button
            onClick={saveTrigger}
            disabled={savingTrigger || trigger === bot.triggerPattern}
            className="rounded-lg bg-accent-500 text-white px-4 py-2 text-sm font-medium hover:bg-accent-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {savingTrigger ? t('common.saving') : t('common.save')}
          </button>
        </div>
        {triggerStatus === 'saved' && <p className="text-sm text-emerald-600 mt-2">{t('common.saved')}</p>}
        {triggerStatus === 'error' && <p className="text-sm text-red-600 mt-2">{t('common.failedToSave')}</p>}
      </div>

      {/* Danger zone */}
      <div className="bg-white rounded-xl shadow-sm border-2 border-red-200 p-5">
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle size={18} className="text-red-500" />
          <h2 className="text-base font-semibold text-red-700">{t('botDetail.settings.dangerZone')}</h2>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          {t('botDetail.settings.dangerDesc')}
        </p>
        <button
          onClick={deleteBot}
          disabled={deleting}
          className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 text-white px-4 py-2 text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Trash2 size={16} /> {deleting ? t('common.deleting') : t('botDetail.settings.deleteBot')}
        </button>
      </div>
    </div>
  );
}

/* ── Skills tab (bot owner) — merged: platform skills + bundled whitelist ── */

function BotSkillsTab({ bot, botId, loadData }: { bot: Bot; botId: string; loadData: () => void }) {
  const { t } = useTranslation();

  // Platform skills (from admin library)
  const [platformSkills, setPlatformSkills] = useState<BotSkillEntry[]>([]);
  const [selectedPlatform, setSelectedPlatform] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  // Bundled skill whitelist (from bot.toolWhitelist)
  const [skillsEnabled, setSkillsEnabled] = useState(bot.toolWhitelist?.skillsEnabled ?? false);
  const [allowedSkills, setAllowedSkills] = useState<string[]>(bot.toolWhitelist?.allowedSkills ?? []);
  const [customSkill, setCustomSkill] = useState('');
  const [catalog, setCatalog] = useState<AvailableTools | null>(null);

  // Shared state
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      botsApi.listSkills(botId),
      botsApi.availableTools(),
    ]).then(([skillsRes, catalogRes]) => {
      setPlatformSkills(skillsRes.skills);
      setSelectedPlatform(new Set(skillsRes.skills.filter((s) => s.enabled).map((s) => s.skillId)));
      setCatalog(catalogRes);
    }).catch(console.error).finally(() => setLoading(false));
  }, [botId]);

  useEffect(() => {
    setSkillsEnabled(bot.toolWhitelist?.skillsEnabled ?? false);
    setAllowedSkills(bot.toolWhitelist?.allowedSkills ?? []);
  }, [bot.toolWhitelist]);

  function togglePlatformSkill(skillId: string) {
    setStatus(null);
    setSelectedPlatform((prev) => {
      const next = new Set(prev);
      if (next.has(skillId)) next.delete(skillId);
      else next.add(skillId);
      return next;
    });
  }

  function toggleBundledSkill(name: string) {
    setAllowedSkills(prev =>
      prev.includes(name) ? prev.filter(s => s !== name) : [...prev, name]
    );
  }

  function addCustomSkill() {
    const trimmed = customSkill.trim();
    if (trimmed && !allowedSkills.includes(trimmed)) {
      setAllowedSkills(prev => [...prev, trimmed]);
      setCustomSkill('');
    }
  }

  const catalogSkillNames = catalog?.skills.map(s => s.name) ?? [];
  const customSkills = allowedSkills.filter(s => !catalogSkillNames.includes(s));

  async function handleSave() {
    setSaving(true);
    setStatus(null);
    try {
      // Save both: platform skill selection + bundled skill whitelist
      await Promise.all([
        botsApi.updateSkills(botId, Array.from(selectedPlatform)),
        botsApi.update(botId, {
          toolWhitelist: {
            mcpToolsEnabled: bot.toolWhitelist?.mcpToolsEnabled ?? false,
            allowedMcpTools: bot.toolWhitelist?.allowedMcpTools ?? [],
            skillsEnabled,
            allowedSkills,
          },
        } as Partial<Bot>),
      ]);
      setStatus('saved');
      setTimeout(() => setStatus(null), 3000);
      loadData();
    } catch {
      setStatus('error');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="text-center py-12 text-slate-400">{t('common.loading')}</div>;

  return (
    <div className="space-y-6">
      {/* Header + Save */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{t('botDetail.skills.title')}</h2>
          <p className="text-sm text-slate-500">{t('botDetail.skills.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          {status === 'saved' && <span className="text-sm text-emerald-600 font-medium">{t('botDetail.skills.saved')}</span>}
          {status === 'error' && <span className="text-sm text-red-600 font-medium">{t('botDetail.skills.error')}</span>}
          <button
            onClick={handleSave}
            disabled={saving}
            className={clsx(
              'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors',
              saving ? 'bg-accent-400 cursor-not-allowed' : 'bg-accent-600 hover:bg-accent-700',
            )}
          >
            <Save size={16} />
            {saving ? t('botDetail.skills.saving') : t('botDetail.skills.save')}
          </button>
        </div>
      </div>

      {/* Section 1: Platform Skills */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <h3 className="text-sm font-semibold text-slate-900 mb-3">{t('botDetail.skills.platformSkills')}</h3>
        {platformSkills.length === 0 ? (
          <p className="text-sm text-slate-400">{t('botDetail.skills.noSkills')}</p>
        ) : (
          <div className="divide-y divide-slate-100 -mx-5">
            {platformSkills.map((skill) => (
              <label key={skill.skillId} className="flex items-center gap-4 px-5 py-3 hover:bg-slate-50 cursor-pointer transition-colors">
                <input
                  type="checkbox"
                  checked={selectedPlatform.has(skill.skillId)}
                  onChange={() => togglePlatformSkill(skill.skillId)}
                  className="h-4 w-4 rounded border-slate-300 text-accent-600 focus:ring-accent-500"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-900">{skill.name}</span>
                    <span className="text-xs text-slate-400">v{skill.version}</span>
                    <Badge variant="neutral">{skill.fileCount} {skill.fileCount === 1 ? 'file' : 'files'}</Badge>
                  </div>
                  {skill.description && (
                    <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">{skill.description}</p>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Section 2: Bundled Skill Whitelist */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-900">{t('botDetail.skills.bundledSkills')}</h3>
          <button
            onClick={() => setSkillsEnabled(!skillsEnabled)}
            className={clsx(
              'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
              skillsEnabled ? 'bg-accent-500' : 'bg-slate-300',
            )}
          >
            <span className={clsx('inline-block h-4 w-4 rounded-full bg-white transition-transform', skillsEnabled ? 'translate-x-6' : 'translate-x-1')} />
          </button>
        </div>
        <p className="text-xs text-slate-400 mb-3">
          {skillsEnabled ? t('botDetail.skills.whitelistEnabled') : t('botDetail.skills.whitelistDisabled')}
        </p>
        <div className={clsx('grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3', !skillsEnabled && 'opacity-50 pointer-events-none')}>
          {catalog?.skills.map(skill => (
            <label key={skill.name} className="flex items-center gap-2 cursor-pointer" title={skill.description}>
              <input
                type="checkbox"
                checked={allowedSkills.includes(skill.name)}
                onChange={() => toggleBundledSkill(skill.name)}
                className="rounded border-slate-300 text-accent-500 focus:ring-accent-500"
              />
              <span className="text-sm text-slate-700 font-mono">{skill.name}</span>
            </label>
          ))}
        </div>

        {/* Custom skills */}
        <div className={clsx('mt-4 pt-4 border-t border-slate-100', !skillsEnabled && 'opacity-50 pointer-events-none')}>
          <h4 className="text-xs font-semibold text-slate-700 mb-2">{t('botDetail.tools.customSkills')}</h4>
          <div className="flex gap-2 mb-2">
            <input
              value={customSkill}
              onChange={e => setCustomSkill(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomSkill(); } }}
              placeholder={t('botDetail.tools.customSkillPlaceholder')}
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
            />
            <button
              onClick={addCustomSkill}
              disabled={!customSkill.trim()}
              className="rounded-lg bg-slate-100 text-slate-700 px-4 py-2 text-sm font-medium hover:bg-slate-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('botDetail.tools.add')}
            </button>
          </div>
          {customSkills.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {customSkills.map(name => (
                <span key={name} className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-slate-100 text-sm font-mono text-slate-700">
                  {name}
                  <button onClick={() => setAllowedSkills(prev => prev.filter(s => s !== name))} className="text-slate-400 hover:text-red-500 transition-colors">&times;</button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Main component ────────────────────────────────────────────────── */

export default function BotDetail() {
  const { t } = useTranslation();
  const { botId } = useParams<{ botId: string }>();
  const [bot, setBot] = useState<Bot | null>(null);
  const [channelsList, setChannels] = useState<ChannelConfig[]>([]);
  const [groupsList, setGroups] = useState<Group[]>([]);
  const [tasksList, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [providersList, setProvidersList] = useState<ProviderPublic[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [savingModel, setSavingModel] = useState(false);
  const [modelStatus, setModelStatus] = useState<'saved' | 'error' | null>(null);
  const [activeTab, setActiveTab] = useState('overview');

  const tabs = Object.keys(tabIcons).map(key => ({
    key,
    label: t(`botDetail.tabs.${key}`),
    icon: tabIcons[key],
  }));

  useEffect(() => { if (botId) loadData(); }, [botId]);

  async function loadData() {
    try {
      const [botData, chs, grps, tks, provs] = await Promise.all([
        botsApi.get(botId!),
        channelsApi.list(botId!),
        groupsApi.list(botId!),
        tasksApi.list(botId!),
        providersApi.list(),
      ]);
      setBot(botData);
      setChannels(chs);
      setGroups(grps);
      setTasks(tks);
      setEditName(botData.name);
      setEditDesc(botData.description || '');
      setProvidersList(provs);

      // Set selected provider/model from bot data
      if (botData.providerId) {
        setSelectedProviderId(botData.providerId);
        setSelectedModelId(botData.modelId || '');
      } else if (provs.length > 0) {
        // No provider set yet — use default or first
        const defaultProv = provs.find(p => p.isDefault) || provs[0];
        setSelectedProviderId(defaultProv.providerId);
        setSelectedModelId(defaultProv.modelIds[0] || '');
      }
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
    if (!selectedProviderId || !selectedModelId) return;
    setSavingModel(true);
    setModelStatus(null);
    try {
      await botsApi.update(botId!, { providerId: selectedProviderId, modelId: selectedModelId });
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

  if (loading) return <div className="text-center py-12 text-slate-500">{t('common.loading')}</div>;
  if (!bot) return <div className="text-center py-12 text-slate-500">{t('common.botNotFound')}</div>;

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
            providersList={providersList}
            selectedProviderId={selectedProviderId}
            setSelectedProviderId={setSelectedProviderId}
            selectedModelId={selectedModelId}
            setSelectedModelId={setSelectedModelId}
            saveModel={saveModel}
            savingModel={savingModel}
            modelStatus={modelStatus}
            channelCount={channelsList.length}
            conversationCount={groupsList.length}
            taskCount={tasksList.length}
          />
        )}
        {activeTab === 'channels' && (
          <ChannelsTab botId={botId!} channelsList={channelsList} loadData={loadData} />
        )}
        {activeTab === 'conversations' && (
          <ConversationsTab botId={botId!} groupsList={groupsList} />
        )}
        {activeTab === 'tasks' && (
          <TasksTab botId={botId!} tasksList={tasksList} loadData={loadData} />
        )}
        {activeTab === 'memory' && (
          <MemoryTab botId={botId!} />
        )}
        {activeTab === 'files' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">{t('botDetail.files.title')}</h2>
              <p className="text-sm text-slate-500">{t('botDetail.files.subtitle')}</p>
            </div>
            <FileBrowser botId={botId!} />
          </div>
        )}
        {activeTab === 'tools' && (
          <ToolsTab bot={bot} botId={botId!} loadData={loadData} />
        )}
        {activeTab === 'skills' && (
          <BotSkillsTab bot={bot} botId={botId!} loadData={loadData} />
        )}
        {activeTab === 'settings' && (
          <SettingsTab bot={bot} botId={botId!} loadData={loadData} />
        )}
      </div>
    </div>
  );
}
