import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Ban, PlayCircle, Trash2 } from 'lucide-react';
import { admin, AdminUser } from '../../lib/api';
import Badge from '../../components/Badge';

export default function UserList() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPlan, setNewPlan] = useState('free');
  const [creating, setCreating] = useState(false);

  function loadUsers() {
    setLoading(true);
    admin.listUsers()
      .then(setUsers)
      .catch((err) => console.error('Failed to load users:', err))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadUsers(); }, []);

  function formatDate(dateStr?: string): string {
    if (!dateStr) return '\u2014';
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? '\u2014' : d.toLocaleDateString();
  }

  async function createUser() {
    if (!newEmail.trim()) return;
    setCreating(true);
    try {
      const result = await admin.createUser(newEmail.trim(), newPlan);
      if (result.temporaryPassword) {
        alert(`User created!\n\nEmail: ${result.email}\nTemporary password: ${result.temporaryPassword}\n\nPlease share this password with the user. They will be required to change it on first login.`);
      }
      setShowCreate(false);
      setNewEmail('');
      setNewPlan('free');
      loadUsers();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create user';
      alert(message);
    } finally {
      setCreating(false);
    }
  }

  async function handleSuspend(userId: string) {
    if (!window.confirm('Suspend this user? They will lose access to the platform.')) return;
    try {
      await admin.updateUserStatus(userId, 'suspended');
      loadUsers();
    } catch (err) {
      console.error('Failed to suspend user:', err);
    }
  }

  async function handleActivate(userId: string) {
    if (!window.confirm('Activate this user?')) return;
    try {
      await admin.updateUserStatus(userId, 'active');
      loadUsers();
    } catch (err) {
      console.error('Failed to activate user:', err);
    }
  }

  async function handleDelete(userId: string) {
    if (!window.confirm('Delete this user? This action cannot be undone.')) return;
    try {
      await admin.deleteUser(userId);
      loadUsers();
    } catch (err) {
      console.error('Failed to delete user:', err);
    }
  }

  // Filter out deleted users by default
  const visibleUsers = users.filter((u) => u.status !== 'deleted');

  if (loading) return <div className="text-center py-12 text-slate-400">Loading...</div>;

  return (
    <div className="animate-fade-in">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Admin &mdash; Users</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent-500 text-white px-4 py-2 text-sm font-medium hover:bg-accent-600 transition-colors"
        >
          <Plus size={16} /> Add User
        </button>
      </div>

      {/* Create user form */}
      {showCreate && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-3 mb-6">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
            <input
              type="email"
              placeholder="user@example.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Plan</label>
            <select
              value={newPlan}
              onChange={(e) => setNewPlan(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
            >
              <option value="free">Free</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={createUser}
              disabled={creating || !newEmail.trim()}
              className="rounded-lg bg-accent-500 text-white px-4 py-2 text-sm font-medium hover:bg-accent-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
            <button
              onClick={() => { setShowCreate(false); setNewEmail(''); setNewPlan('free'); }}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Email</th>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Plan</th>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Status</th>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Tokens (used / max)</th>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Bots</th>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Last Login</th>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-slate-200">
            {visibleUsers.map((u) => {
              const status = u.status || 'active';
              return (
                <tr key={u.userId} className="hover:bg-slate-50 transition-colors">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Link to={`/admin/users/${u.userId}`} className="text-accent-600 hover:text-accent-500 font-medium">
                      {u.email || u.userId}
                    </Link>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Badge variant={
                      u.plan === 'enterprise' ? 'info' :
                      u.plan === 'pro' ? 'success' :
                      'neutral'
                    }>{u.plan}</Badge>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Badge variant={
                      status === 'active' ? 'success' :
                      status === 'suspended' ? 'warning' :
                      'error'
                    }>{status}</Badge>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-700">
                    {(u.usageTokens ?? 0).toLocaleString()} / {u.quota?.maxMonthlyTokens?.toLocaleString() ?? '\u2014'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-700">
                    {(u.botCount ?? 0).toLocaleString()} / {u.quota?.maxBots?.toLocaleString() ?? '\u2014'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                    {formatDate(u.lastLogin)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-1">
                      {status === 'active' ? (
                        <button
                          onClick={() => handleSuspend(u.userId)}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-amber-600 hover:bg-amber-50 transition-colors"
                          title="Suspend"
                        >
                          <Ban size={14} /> Suspend
                        </button>
                      ) : status === 'suspended' ? (
                        <button
                          onClick={() => handleActivate(u.userId)}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-50 transition-colors"
                          title="Activate"
                        >
                          <PlayCircle size={14} /> Activate
                        </button>
                      ) : null}
                      <button
                        onClick={() => handleDelete(u.userId)}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={14} /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {visibleUsers.length === 0 && (
              <tr>
                <td colSpan={7} className="px-6 py-8 text-center text-slate-500">No users found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
