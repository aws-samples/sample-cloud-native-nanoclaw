import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { bots as botsApi, user as userApi, Bot } from '../lib/api';

export default function Dashboard() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newBotName, setNewBotName] = useState('');
  const [usage, setUsage] = useState<{ month: string; tokens: number; invocations: number } | null>(null);
  const [quota, setQuota] = useState<any>(null);

  useEffect(() => { loadBots(); loadUsage(); }, []);

  async function loadBots() {
    try {
      const data = await botsApi.list();
      setBots(data);
    } catch (err) {
      console.error('Failed to load bots:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadUsage() {
    try {
      const me = await userApi.me();
      if (me.usage) setUsage({ month: me.usage.month || '', tokens: me.usage.tokens ?? 0, invocations: me.usage.invocations ?? 0 });
      if (me.quota) setQuota(me.quota);
    } catch (err) {
      console.error('Failed to load usage:', err);
    }
  }

  async function createBot() {
    if (!newBotName.trim()) return;
    try {
      await botsApi.create({ name: newBotName, triggerPattern: `@${newBotName}` });
      setNewBotName('');
      setShowCreate(false);
      loadBots();
    } catch (err) {
      console.error('Failed to create bot:', err);
    }
  }

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;

  return (
    <div>
      {usage && (
        <div className="mb-6 p-4 bg-white rounded-lg shadow flex items-center justify-between">
          <div className="flex items-center gap-6 text-sm text-gray-700">
            <span>
              Token Usage: <span className="font-semibold">{usage.tokens.toLocaleString()}</span>
              {quota?.maxMonthlyTokens != null && <span className="text-gray-400"> / {Number(quota.maxMonthlyTokens).toLocaleString()}</span>}
            </span>
            <span className="text-gray-300">|</span>
            <span>
              Invocations: <span className="font-semibold">{usage.invocations.toLocaleString()}</span>
            </span>
            <span className="text-gray-300">|</span>
            <span className="text-gray-400">{usage.month}</span>
          </div>
          <Link to="/memory" className="text-sm text-indigo-600 hover:text-indigo-500">Shared Memory</Link>
        </div>
      )}

      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">My Bots</h1>
        <button onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 text-sm">
          Create Bot
        </button>
      </div>

      {showCreate && (
        <div className="mb-6 p-4 bg-white rounded-lg shadow">
          <div className="flex gap-3">
            <input type="text" placeholder="Bot name..." value={newBotName} onChange={e => setNewBotName(e.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500" />
            <button onClick={createBot} className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 text-sm">Create</button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-gray-600 hover:text-gray-800 text-sm">Cancel</button>
          </div>
        </div>
      )}

      {bots.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg shadow">
          <p className="text-gray-500">No bots yet. Create your first bot to get started.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {bots.map((bot) => (
            <Link key={bot.botId} to={`/bots/${bot.botId}`}
              className="block p-6 bg-white rounded-lg shadow hover:shadow-md transition-shadow">
              <div className="flex justify-between items-start">
                <h3 className="text-lg font-semibold text-gray-900">{bot.name}</h3>
                <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                  bot.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                }`}>{bot.status}</span>
              </div>
              {bot.description && <p className="mt-2 text-sm text-gray-600">{bot.description}</p>}
              <p className="mt-3 text-xs text-gray-400">Trigger: {bot.triggerPattern}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
