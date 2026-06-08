import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  user as userApi,
  admin as adminApi,
  proxyRules as proxyRulesApi,
  type ProviderFull,
  type CreateProviderRequest,
  type ProxyRuleSummary,
  type ProxyRuleInput,
} from '../lib/api';
import Badge from '../components/Badge';
import { Plus, Trash2, Edit2, Shield, Server, Star, X } from 'lucide-react';

type Tab = 'providers' | 'credentials';

// ── Model Presets ─────────────────────────────────────────────────────────

const BEDROCK_PRESETS = [
  'global.anthropic.claude-sonnet-4-6',
  'global.anthropic.claude-opus-4-6-v1',
  'global.anthropic.claude-opus-4-7',
  'global.anthropic.claude-opus-4-8',
];
const ANTHROPIC_PRESETS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
];

// ── Providers Tab (Admin only) ────────────────────────────────────────────

interface ProviderForm {
  providerName: string;
  providerType: 'bedrock' | 'anthropic-compatible-api';
  baseUrl: string;
  apiKey: string;
  modelIds: string[];
  isDefault: boolean;
}

const EMPTY_FORM: ProviderForm = {
  providerName: '',
  providerType: 'bedrock',
  baseUrl: '',
  apiKey: '',
  modelIds: [],
  isDefault: false,
};

function ProvidersTab() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ProviderFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null); // null, 'new', or providerId
  const [form, setForm] = useState<ProviderForm>({ ...EMPTY_FORM });
  const [customModel, setCustomModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { loadProviders(); }, []);

  async function loadProviders() {
    try {
      const data = await adminApi.listProviders();
      setProviders(data);
    } catch (err) {
      console.error('Failed to load providers:', err);
    } finally {
      setLoading(false);
    }
  }

  function startNew() {
    setEditing('new');
    setForm({ ...EMPTY_FORM });
    setCustomModel('');
    setError('');
  }

  function startEdit(provider: ProviderFull) {
    setEditing(provider.providerId);
    setForm({
      providerName: provider.providerName,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl || '',
      apiKey: '',
      modelIds: [...provider.modelIds],
      isDefault: provider.isDefault,
    });
    setCustomModel('');
    setError('');
  }

  function cancel() {
    setEditing(null);
    setError('');
  }

  function toggleModel(modelId: string) {
    setForm((f) => ({
      ...f,
      modelIds: f.modelIds.includes(modelId)
        ? f.modelIds.filter((m) => m !== modelId)
        : [...f.modelIds, modelId],
    }));
  }

  function addCustomModel() {
    const trimmed = customModel.trim();
    if (!trimmed || form.modelIds.includes(trimmed)) return;
    setForm((f) => ({ ...f, modelIds: [...f.modelIds, trimmed] }));
    setCustomModel('');
  }

  function removeModel(modelId: string) {
    setForm((f) => ({ ...f, modelIds: f.modelIds.filter((m) => m !== modelId) }));
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      if (editing === 'new') {
        const payload: CreateProviderRequest = {
          providerName: form.providerName,
          providerType: form.providerType,
          modelIds: form.modelIds,
          isDefault: form.isDefault,
        };
        if (form.providerType === 'anthropic-compatible-api') {
          if (form.baseUrl.trim()) payload.baseUrl = form.baseUrl.trim();
          if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
        } else {
          // Bedrock: apiKey is optional (for cross-account scenarios)
          if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
        }
        await adminApi.createProvider(payload);
      } else {
        const payload: Record<string, unknown> = {
          providerName: form.providerName,
          providerType: form.providerType,
          modelIds: form.modelIds,
          isDefault: form.isDefault,
        };
        if (form.providerType === 'anthropic-compatible-api') {
          payload.baseUrl = form.baseUrl.trim() || null;
          if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
        } else {
          if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
        }
        await adminApi.updateProvider(editing!, payload);
      }
      setEditing(null);
      await loadProviders();
    } catch (err: any) {
      setError(err.message || 'Failed to save provider');
    } finally {
      setSaving(false);
    }
  }

  async function remove(providerId: string) {
    if (!confirm(t('settings.providers.deleteConfirm'))) return;
    try {
      await adminApi.deleteProvider(providerId);
      await loadProviders();
    } catch (err) {
      console.error('Failed to delete provider:', err);
    }
  }

  const presets = form.providerType === 'bedrock' ? BEDROCK_PRESETS : ANTHROPIC_PRESETS;

  if (loading) return <div className="text-center py-12 text-slate-400">{t('common.loading')}</div>;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-slate-900">{t('settings.providers.title')}</h2>
          {!editing && (
            <button onClick={startNew} className="inline-flex items-center gap-1.5 rounded-lg bg-accent-500 text-white px-3 py-2 text-sm font-medium hover:bg-accent-600">
              <Plus size={16} /> {t('settings.providers.addProvider')}
            </button>
          )}
        </div>
        <p className="text-sm text-slate-500 mb-4">
          {t('settings.providers.description')}
        </p>

        {providers.length > 0 && (
          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2 font-medium">{t('settings.credentials.name')}</th>
                <th className="py-2 font-medium">{t('settings.providers.providerType')}</th>
                <th className="py-2 font-medium">{t('settings.providers.modelIds')}</th>
                <th className="py-2 font-medium">{t('settings.providers.default')}</th>
                <th className="py-2 font-medium">{t('settings.providers.apiKey')}</th>
                <th className="py-2 font-medium text-right">{t('settings.credentials.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.providerId} className="border-b border-slate-100">
                  <td className="py-2.5 font-medium text-slate-900">{p.providerName}</td>
                  <td className="py-2.5">
                    <Badge variant={p.providerType === 'bedrock' ? 'info' : 'neutral'}>
                      {p.providerType === 'bedrock' ? t('settings.providers.bedrock') : t('settings.providers.anthropicApi')}
                    </Badge>
                  </td>
                  <td className="py-2.5 text-slate-600">{p.modelIds.length} {p.modelIds.length !== 1 ? t('settings.providers.models') : t('settings.providers.model')}</td>
                  <td className="py-2.5">
                    {p.isDefault && (
                      <span className="inline-flex items-center gap-1 text-amber-600">
                        <Star size={14} className="fill-amber-400" /> {t('settings.providers.default')}
                      </span>
                    )}
                  </td>
                  <td className="py-2.5">
                    {p.hasApiKey ? (
                      <Badge variant="success">{t('settings.providers.configured')}</Badge>
                    ) : p.providerType === 'bedrock' ? (
                      <Badge variant="neutral">{t('settings.providers.none')}</Badge>
                    ) : (
                      <Badge variant="error">{t('settings.providers.missing')}</Badge>
                    )}
                  </td>
                  <td className="py-2.5 text-right">
                    <button onClick={() => startEdit(p)} className="text-slate-400 hover:text-accent-600 p-1"><Edit2 size={15} /></button>
                    <button onClick={() => remove(p.providerId)} className="text-slate-400 hover:text-red-600 p-1 ml-1"><Trash2 size={15} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {providers.length === 0 && !editing && (
          <div className="text-center py-8 text-slate-400">
            {t('settings.providers.noProviders')}
          </div>
        )}
      </div>

      {/* Provider Form */}
      {editing && (
        <div className="bg-white rounded-xl shadow-sm border border-accent-200 p-6">
          <h3 className="text-md font-semibold text-slate-900 mb-4">
            {editing === 'new' ? t('settings.providers.addProvider') : t('settings.providers.editProvider')}
          </h3>
          {error && <div className="text-sm text-red-600 mb-3">{error}</div>}
          <div className="grid grid-cols-2 gap-4">
            {/* Provider Name */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.providers.providerName')}</label>
              <input
                value={form.providerName}
                onChange={(e) => setForm((f) => ({ ...f, providerName: e.target.value }))}
                placeholder={t('settings.providers.providerNamePlaceholder')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>

            {/* Provider Type */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.providers.providerType')}</label>
              <select
                value={form.providerType}
                onChange={(e) => {
                  const newType = e.target.value as ProviderForm['providerType'];
                  setForm((f) => ({ ...f, providerType: newType, modelIds: [], baseUrl: '', apiKey: '' }));
                }}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              >
                <option value="bedrock">{t('settings.providers.bedrock')}</option>
                <option value="anthropic-compatible-api">{t('settings.providers.anthropicApi')}</option>
              </select>
            </div>

            {/* Base URL (anthropic-compatible-api only) */}
            {form.providerType === 'anthropic-compatible-api' && (
              <div className="col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.providers.baseUrl')}</label>
                <input
                  type="url"
                  value={form.baseUrl}
                  onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                  placeholder={t('settings.providers.baseUrlPlaceholder')}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
                />
                <p className="text-xs text-slate-400 mt-1">{t('settings.providers.baseUrlHint')}</p>
              </div>
            )}

            {/* API Key */}
            {(form.providerType === 'anthropic-compatible-api' || form.providerType === 'bedrock') && (
              <div className="col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  {t('settings.providers.apiKey')} {form.providerType === 'bedrock' && <span className="text-slate-400 font-normal">{t('settings.providers.apiKeyOptional')}</span>}
                  {editing !== 'new' && <span className="text-slate-400 font-normal">{t('settings.providers.apiKeyKeepCurrent')}</span>}
                </label>
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                  placeholder={editing !== 'new' ? t('settings.providers.apiKeyPlaceholderKeep') : form.providerType === 'bedrock' ? t('settings.providers.apiKeyPlaceholderBedrock') : t('settings.providers.apiKeyPlaceholderNew')}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
                />
              </div>
            )}

            {/* Model IDs Section */}
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-2">{t('settings.providers.modelIds')}</label>

              {/* Preset checkboxes */}
              <div className="space-y-2 mb-3">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{t('settings.providers.presets')}</p>
                <div className="flex flex-wrap gap-3">
                  {presets.map((modelId) => (
                    <label key={modelId} className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.modelIds.includes(modelId)}
                        onChange={() => toggleModel(modelId)}
                        className="rounded border-slate-300 text-accent-500 focus:ring-accent-500/20"
                      />
                      <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">{modelId}</code>
                    </label>
                  ))}
                </div>
              </div>

              {/* Custom model input */}
              <div className="flex items-center gap-2 mb-3">
                <input
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomModel(); } }}
                  placeholder={t('settings.providers.addCustomModel')}
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
                />
                <button
                  onClick={addCustomModel}
                  disabled={!customModel.trim()}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus size={14} /> {t('settings.providers.add')}
                </button>
              </div>

              {/* Selected models as removable chips */}
              {form.modelIds.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {form.modelIds.map((modelId) => (
                    <span
                      key={modelId}
                      className="inline-flex items-center gap-1 rounded-full bg-accent-50 text-accent-700 px-2.5 py-1 text-xs font-medium ring-1 ring-inset ring-accent-600/20"
                    >
                      {modelId}
                      <button onClick={() => removeModel(modelId)} className="hover:text-red-600 ml-0.5">
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {form.modelIds.length === 0 && (
                <p className="text-xs text-slate-400">{t('settings.providers.noModels')}</p>
              )}
            </div>

            {/* Set as default */}
            <div className="col-span-2">
              <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isDefault}
                  onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))}
                  className="rounded border-slate-300 text-accent-500 focus:ring-accent-500/20"
                />
                <span className="flex items-center gap-1">
                  <Star size={14} className="text-amber-500" /> {t('settings.providers.setDefault')}
                </span>
              </label>
              <p className="text-xs text-slate-400 mt-1 ml-6">{t('settings.providers.setDefaultHint')}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={save}
              disabled={saving || !form.providerName.trim() || form.modelIds.length === 0}
              className="rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? t('common.saving') : t('settings.providers.saveProvider')}
            </button>
            <button onClick={cancel} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CredentialsTab() {
  const { t } = useTranslation();

  const PRESETS: Array<Omit<ProxyRuleInput, 'value'> & { description: string }> = [
    { name: 'Anthropic', prefix: '/anthropic', target: 'https://api.anthropic.com', authType: 'api-key', headerName: 'x-api-key', description: t('settings.credentials.presetAnthropic') },
    { name: 'OpenAI', prefix: '/openai', target: 'https://api.openai.com', authType: 'bearer', description: t('settings.credentials.presetOpenai') },
    { name: 'GitHub', prefix: '/github', target: 'https://api.github.com', authType: 'bearer', description: t('settings.credentials.presetGithub') },
    { name: 'Jira', prefix: '/jira', target: 'https://your-domain.atlassian.net', authType: 'basic', description: t('settings.credentials.presetJira') },
    { name: 'Google AI', prefix: '/google-ai', target: 'https://generativelanguage.googleapis.com', authType: 'api-key', headerName: 'x-goog-api-key', description: t('settings.credentials.presetGoogleAi') },
  ];
  const authTypeLabels: Record<string, string> = {
    'bearer': t('settings.credentials.bearerToken'),
    'api-key': t('settings.credentials.apiKeyHeader'),
    'basic': t('settings.credentials.basicAuth'),
  };
  const [rules, setRules] = useState<ProxyRuleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<ProxyRuleInput>({ name: '', prefix: '', target: '', authType: 'bearer', value: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { loadRules(); }, []);

  async function loadRules() {
    try {
      const data = await proxyRulesApi.list();
      setRules(data);
    } catch (err) {
      console.error('Failed to load proxy rules:', err);
    } finally {
      setLoading(false);
    }
  }

  function startNew() {
    setEditing('new');
    setForm({ name: '', prefix: '/', target: 'https://', authType: 'bearer', value: '' });
    setError('');
  }

  function startFromPreset(preset: typeof PRESETS[number]) {
    setEditing('new');
    setForm({ name: preset.name, prefix: preset.prefix, target: preset.target, authType: preset.authType, headerName: preset.headerName, value: '' });
    setError('');
  }

  function startEdit(rule: ProxyRuleSummary) {
    setEditing(rule.id);
    setForm({ name: rule.name, prefix: rule.prefix, target: rule.target, authType: rule.authType, headerName: rule.headerName, value: '' });
    setError('');
  }

  function cancel() {
    setEditing(null);
    setError('');
  }

  function handleNameChange(name: string) {
    const prefix = '/' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    setForm((f) => ({ ...f, name, prefix }));
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      if (editing === 'new') {
        await proxyRulesApi.create(form);
      } else {
        // Strip empty value to preserve existing secret
        const payload = { ...form };
        if (!payload.value) delete (payload as Partial<ProxyRuleInput>).value;
        await proxyRulesApi.update(editing!, payload);
      }
      setEditing(null);
      await loadRules();
    } catch (err: any) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm(t('settings.credentials.deleteConfirm'))) return;
    try {
      await proxyRulesApi.remove(id);
      await loadRules();
    } catch (err) {
      console.error('Failed to delete rule:', err);
    }
  }

  if (loading) return <div className="text-center py-12 text-slate-400">{t('common.loading')}</div>;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-slate-900">{t('settings.credentials.title')}</h2>
          {!editing && (
            <button onClick={startNew} className="inline-flex items-center gap-1.5 rounded-lg bg-accent-500 text-white px-3 py-2 text-sm font-medium hover:bg-accent-600">
              <Plus size={16} /> {t('settings.credentials.addRule')}
            </button>
          )}
        </div>
        <p className="text-sm text-slate-500 mb-4">
          {t('settings.credentials.description')}
        </p>

        {rules.length > 0 && (
          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2 font-medium">{t('settings.credentials.name')}</th>
                <th className="py-2 font-medium">{t('settings.credentials.target')}</th>
                <th className="py-2 font-medium">{t('settings.credentials.authType')}</th>
                <th className="py-2 font-medium">{t('settings.credentials.prefix')}</th>
                <th className="py-2 font-medium">{t('settings.credentials.status')}</th>
                <th className="py-2 font-medium text-right">{t('settings.credentials.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-slate-100">
                  <td className="py-2.5 font-medium text-slate-900">{rule.name}</td>
                  <td className="py-2.5 text-slate-600 truncate max-w-[200px]">{rule.target}</td>
                  <td className="py-2.5 text-slate-600">{authTypeLabels[rule.authType]}</td>
                  <td className="py-2.5"><code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">{rule.prefix}</code></td>
                  <td className="py-2.5">{rule.hasValue ? <Badge variant="success">{t('settings.providers.configured')}</Badge> : <Badge variant="warning">{t('settings.credentials.noKey')}</Badge>}</td>
                  <td className="py-2.5 text-right">
                    <button onClick={() => startEdit(rule)} className="text-slate-400 hover:text-accent-600 p-1"><Edit2 size={15} /></button>
                    <button onClick={() => remove(rule.id)} className="text-slate-400 hover:text-red-600 p-1 ml-1"><Trash2 size={15} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {rules.length === 0 && !editing && (
          <div className="text-center py-8 text-slate-400">
            {t('settings.credentials.noRules')}
          </div>
        )}

        {/* Presets — show available templates (hide already-configured ones) */}
        {!editing && (() => {
          const existingPrefixes = new Set(rules.map((r) => r.prefix));
          const available = PRESETS.filter((p) => !existingPrefixes.has(p.prefix));
          if (available.length === 0) return null;
          return (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <p className="text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">{t('settings.credentials.quickAdd')}</p>
              <div className="flex flex-wrap gap-2">
                {available.map((preset) => (
                  <button
                    key={preset.prefix}
                    onClick={() => startFromPreset(preset)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-700 hover:bg-accent-50 hover:border-accent-200 hover:text-accent-700 transition-colors"
                  >
                    <Plus size={14} /> {preset.name} <span className="text-slate-400">— {preset.description}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })()}
      </div>

      {editing && (
        <div className="bg-white rounded-xl shadow-sm border border-accent-200 p-6">
          <h3 className="text-md font-semibold text-slate-900 mb-4">{editing === 'new' ? t('settings.credentials.addRule') : t('settings.credentials.editRule')}</h3>
          {error && <div className="text-sm text-red-600 mb-3">{error}</div>}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.credentials.name')}</label>
              <input
                value={form.name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder={t('settings.credentials.namePlaceholder')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.credentials.pathPrefix')}</label>
              <input
                value={form.prefix}
                onChange={(e) => setForm((f) => ({ ...f, prefix: e.target.value }))}
                placeholder={t('settings.credentials.pathPrefixPlaceholder')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-mono focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.credentials.targetUrl')}</label>
              <input
                value={form.target}
                onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))}
                placeholder={t('settings.credentials.targetUrlPlaceholder')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.credentials.authType')}</label>
              <select
                value={form.authType}
                onChange={(e) => setForm((f) => ({ ...f, authType: e.target.value as ProxyRuleInput['authType'] }))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              >
                <option value="bearer">{t('settings.credentials.bearerToken')}</option>
                <option value="api-key">{t('settings.credentials.apiKeyHeader')}</option>
                <option value="basic">{t('settings.credentials.basicAuth')}</option>
              </select>
            </div>
            {form.authType === 'api-key' && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.credentials.headerName')}</label>
                <input
                  value={form.headerName || ''}
                  onChange={(e) => setForm((f) => ({ ...f, headerName: e.target.value }))}
                  placeholder={t('settings.credentials.headerNamePlaceholder')}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
                />
              </div>
            )}
            <div className={form.authType === 'api-key' ? 'col-span-2' : ''}>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {t('settings.credentials.secret')} {editing !== 'new' && <span className="text-slate-400 font-normal">{t('settings.credentials.secretKeepCurrent')}</span>}
              </label>
              <input
                type="password"
                value={form.value}
                onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                placeholder={editing !== 'new' ? t('settings.credentials.secretPlaceholderKeep') : t('settings.credentials.secretPlaceholderNew')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={save}
              disabled={saving || !form.name || !form.target || (editing === 'new' && !form.value)}
              className="rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? t('common.saving') : t('settings.credentials.saveRule')}
            </button>
            <button onClick={cancel} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Settings Page ────────────────────────────────────────────────────

export default function Settings() {
  const { t } = useTranslation();
  const [isAdmin, setIsAdmin] = useState(false);
  const [tab, setTab] = useState<Tab>('credentials');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    userApi.me().then((me) => {
      setIsAdmin(!!me.isAdmin);
      setTab(me.isAdmin ? 'providers' : 'credentials');
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <div className="animate-fade-in space-y-6">
        <h1 className="text-2xl font-semibold text-slate-900">{t('settings.title')}</h1>
        <div className="text-center py-12 text-slate-400">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">{t('settings.title')}</h1>

      <div className="flex gap-1 border-b border-slate-200">
        {isAdmin && (
          <button
            onClick={() => setTab('providers')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === 'providers'
                ? 'border-accent-500 text-accent-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Server size={16} /> {t('settings.modelProviders')}
          </button>
        )}
        <button
          onClick={() => setTab('credentials')}
          className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            tab === 'credentials'
              ? 'border-accent-500 text-accent-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Shield size={16} /> {t('settings.apiCredentials')}
        </button>
      </div>

      {tab === 'providers' && isAdmin && <ProvidersTab />}
      {tab === 'credentials' && <CredentialsTab />}
    </div>
  );
}
