import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { admin, AdminUser } from '../../lib/api';

export default function UserDetail() {
  const { userId } = useParams<{ userId: string }>();
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

  useEffect(() => {
    if (!userId) return;
    admin.getUser(userId)
      .then((u) => {
        setUser(u);
        setQuota(u.quota);
        setPlan(u.plan);
      })
      .catch((err) => console.error('Failed to load user:', err))
      .finally(() => setLoading(false));
  }, [userId]);

  async function saveQuota() {
    if (!userId) return;
    setSaving(true);
    setMessage('');
    try {
      await admin.updateQuota(userId, quota);
      setMessage('Quota updated successfully.');
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
      setMessage('Plan updated successfully.');
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;
  if (!user) return <div className="text-center py-12 text-gray-500">User not found.</div>;

  const quotaFields = [
    { key: 'maxBots' as const, label: 'Max Bots' },
    { key: 'maxGroupsPerBot' as const, label: 'Max Groups per Bot' },
    { key: 'maxTasksPerBot' as const, label: 'Max Tasks per Bot' },
    { key: 'maxConcurrentAgents' as const, label: 'Max Concurrent Agents' },
    { key: 'maxMonthlyTokens' as const, label: 'Max Monthly Tokens' },
  ];

  return (
    <div>
      <Link to="/admin/users" className="text-sm text-indigo-600 hover:text-indigo-500 mb-4 inline-block">&larr; Back to Users</Link>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">{user.email || user.userId}</h1>

      {message && (
        <div className={`mb-4 p-3 rounded-md text-sm ${message.startsWith('Error') ? 'bg-red-50 text-red-800' : 'bg-green-50 text-green-800'}`}>
          {message}
        </div>
      )}

      {/* User Info */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">User Info</h2>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div><dt className="text-gray-500">User ID</dt><dd className="font-mono text-gray-900">{user.userId}</dd></div>
          <div><dt className="text-gray-500">Email</dt><dd className="text-gray-900">{user.email}</dd></div>
          <div><dt className="text-gray-500">Created</dt><dd className="text-gray-900">{new Date(user.createdAt).toLocaleString()}</dd></div>
          <div><dt className="text-gray-500">Last Login</dt><dd className="text-gray-900">{user.lastLogin ? new Date(user.lastLogin).toLocaleString() : '—'}</dd></div>
        </dl>
      </div>

      {/* Usage Stats */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Usage ({user.usageMonth})</h2>
        <dl className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-gray-500">Tokens</dt>
            <dd className="text-2xl font-bold text-gray-900">{user.usageTokens.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Invocations</dt>
            <dd className="text-2xl font-bold text-gray-900">{user.usageInvocations.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Active Agents</dt>
            <dd className="text-2xl font-bold text-gray-900">{user.activeAgents}</dd>
          </div>
        </dl>
      </div>

      {/* Plan */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Plan</h2>
        <div className="flex items-center gap-3">
          <select value={plan} onChange={(e) => setPlan(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500">
            <option value="free">Free</option>
            <option value="pro">Pro</option>
            <option value="enterprise">Enterprise</option>
          </select>
          <button onClick={savePlan} disabled={saving}
            className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 text-sm disabled:opacity-50">
            Save Plan
          </button>
        </div>
      </div>

      {/* Quota */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Quota</h2>
        <div className="grid grid-cols-2 gap-4">
          {quotaFields.map(({ key, label }) => (
            <div key={key}>
              <label className="block text-sm text-gray-600 mb-1">{label}</label>
              <input type="number" min={0} value={quota[key]}
                onChange={(e) => setQuota({ ...quota, [key]: parseInt(e.target.value, 10) || 0 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500" />
            </div>
          ))}
        </div>
        <button onClick={saveQuota} disabled={saving}
          className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 text-sm disabled:opacity-50">
          Save Quota
        </button>
      </div>
    </div>
  );
}
