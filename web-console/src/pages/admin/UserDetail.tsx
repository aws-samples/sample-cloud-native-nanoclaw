import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Ban, PlayCircle, Trash2 } from 'lucide-react';
import { admin, AdminUser } from '../../lib/api';
import Badge from '../../components/Badge';

function formatDateTime(dateStr?: string): string {
  if (!dateStr) return '\u2014';
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? '\u2014' : d.toLocaleString();
}

export default function UserDetail() {
  const { t } = useTranslation();
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // Editable quota state
  const [quota, setQuota] = useState({
    maxBots: 0,
    maxGroupsPerBot: 0,
    maxTasksPerBot: 0,
    maxConcurrentAgents: 0,
    maxMonthlyTokens: 0,
  });
  const [plan, setPlan] = useState<string>('free');

  function loadUser() {
    if (!userId) return;
    admin.getUser(userId)
      .then((u) => {
        setUser(u);
        setQuota(u.quota);
        setPlan(u.plan);
      })
      .catch((err) => console.error('Failed to load user:', err))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadUser(); }, [userId]);

  async function saveQuota() {
    if (!userId) return;
    setSaving(true);
    setMessage('');
    try {
      await admin.updateQuota(userId, quota);
      setMessage(t('admin.userDetail.quotaUpdated'));
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  }

  async function savePlan() {
    if (!userId) return;
    setSaving(true);
    setMessage('');
    try {
      await admin.updatePlan(userId, plan);
      setMessage(t('admin.userDetail.planUpdated'));
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleSuspend() {
    if (!userId) return;
    if (!window.confirm(t('admin.users.suspendConfirm'))) return;
    try {
      await admin.updateUserStatus(userId, 'suspended');
      setMessage(t('admin.userDetail.userSuspended'));
      loadUser();
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  async function handleActivate() {
    if (!userId) return;
    if (!window.confirm(t('admin.users.activateConfirm'))) return;
    try {
      await admin.updateUserStatus(userId, 'active');
      setMessage(t('admin.userDetail.userActivated'));
      loadUser();
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  async function handleDelete() {
    if (!userId) return;
    if (!window.confirm(t('admin.users.deleteConfirm'))) return;
    try {
      await admin.deleteUser(userId);
      setMessage(t('admin.userDetail.userDeleted'));
      navigate('/admin/users');
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  if (loading) return <div className="text-center py-12 text-slate-400">{t('common.loading')}</div>;
  if (!user) return <div className="text-center py-12 text-slate-400">{t('common.userNotFound')}</div>;

  const status = user.status || 'active';

  const quotaFields = [
    { key: 'maxBots' as const, label: t('admin.plans.maxBots') },
    { key: 'maxGroupsPerBot' as const, label: t('admin.plans.maxGroupsPerBot') },
    { key: 'maxTasksPerBot' as const, label: t('admin.plans.maxTasksPerBot') },
    { key: 'maxConcurrentAgents' as const, label: t('admin.plans.maxConcurrentAgents') },
    { key: 'maxMonthlyTokens' as const, label: t('admin.plans.maxMonthlyTokens') },
  ];

  return (
    <div className="animate-fade-in">
      <Link to="/admin" className="inline-flex items-center gap-1.5 text-sm text-accent-600 hover:text-accent-500 font-medium mb-4">
        <ArrowLeft className="h-4 w-4" />
        {t('common.backToAdmin')}
      </Link>
      <h1 className="text-2xl font-semibold text-slate-900 mb-6">{user.email || user.userId}</h1>

      {message && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${message.startsWith('Error') ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
          {message}
        </div>
      )}

      {/* User Info */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">{t('admin.userDetail.userInfo')}</h2>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div><dt className="text-slate-500">{t('admin.userDetail.userId')}</dt><dd className="font-mono text-slate-900">{user.userId}</dd></div>
          <div><dt className="text-slate-500">{t('admin.userDetail.email')}</dt><dd className="text-slate-900">{user.email}</dd></div>
          <div><dt className="text-slate-500">{t('admin.userDetail.created')}</dt><dd className="text-slate-900">{formatDateTime(user.createdAt)}</dd></div>
          <div><dt className="text-slate-500">{t('admin.userDetail.lastLogin')}</dt><dd className="text-slate-900">{formatDateTime(user.lastLogin)}</dd></div>
        </dl>
      </div>

      {/* Usage Stats */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">{t('admin.userDetail.usage', { month: user.usageMonth })}</h2>
        <dl className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-slate-500">{t('admin.userDetail.tokens')}</dt>
            <dd className="text-2xl font-bold text-slate-900">{(user.usageTokens ?? 0).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t('admin.userDetail.invocations')}</dt>
            <dd className="text-2xl font-bold text-slate-900">{(user.usageInvocations ?? 0).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t('admin.userDetail.bots')}</dt>
            <dd className="text-2xl font-bold text-slate-900">{(user.botCount ?? 0).toLocaleString()} / {user.quota?.maxBots?.toLocaleString() ?? '\u2014'}</dd>
          </div>
        </dl>
      </div>

      {/* Plan */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">{t('admin.userDetail.plan')}</h2>
        <div className="flex items-center gap-3">
          <select value={plan} onChange={(e) => setPlan(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none">
            <option value="free">{t('admin.plans.free')}</option>
            <option value="pro">{t('admin.plans.pro')}</option>
            <option value="enterprise">{t('admin.plans.enterprise')}</option>
          </select>
          <button onClick={savePlan} disabled={saving}
            className="rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 disabled:opacity-50">
            {t('admin.userDetail.savePlan')}
          </button>
        </div>
      </div>

      {/* Status */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">{t('admin.userDetail.status')}</h2>
        <div className="flex items-center gap-4">
          <Badge variant={
            status === 'active' ? 'success' :
            status === 'suspended' ? 'warning' :
            'error'
          }>{status}</Badge>
          <div className="flex items-center gap-2">
            {status === 'active' ? (
              <button
                onClick={handleSuspend}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-700 px-3 py-2 text-sm font-medium hover:bg-amber-100 transition-colors"
              >
                <Ban size={14} /> {t('admin.users.suspend')}
              </button>
            ) : status === 'suspended' ? (
              <button
                onClick={handleActivate}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-700 px-3 py-2 text-sm font-medium hover:bg-emerald-100 transition-colors"
              >
                <PlayCircle size={14} /> {t('admin.users.activate')}
              </button>
            ) : null}
            <button
              onClick={handleDelete}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 text-red-700 px-3 py-2 text-sm font-medium hover:bg-red-100 transition-colors"
            >
              <Trash2 size={14} /> {t('common.delete')}
            </button>
          </div>
        </div>
      </div>

      {/* Quota */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">{t('admin.userDetail.quota')}</h2>
        <div className="grid grid-cols-2 gap-4">
          {quotaFields.map(({ key, label }) => (
            <div key={key}>
              <label className="block text-sm font-medium text-slate-700 mb-1">{label}</label>
              <input type="number" min={0} value={quota[key]}
                onChange={(e) => setQuota({ ...quota, [key]: parseInt(e.target.value, 10) || 0 })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none" />
              {key === 'maxMonthlyTokens' && quota[key] > 0 && (
                <p className="text-xs text-slate-400 mt-1">Current value: {quota[key].toLocaleString()}</p>
              )}
            </div>
          ))}
        </div>
        <button onClick={saveQuota} disabled={saving}
          className="mt-4 rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 disabled:opacity-50">
          {t('admin.userDetail.saveQuota')}
        </button>
      </div>
    </div>
  );
}
