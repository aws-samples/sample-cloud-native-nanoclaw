import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bot as BotIcon, Coins, Zap, BookOpen, ArrowRight } from 'lucide-react';
import StatCard from '../components/StatCard';
import { bots as botsApi, user as userApi, Bot } from '../lib/api';

export default function Dashboard() {
  const { t } = useTranslation();
  const [botList, setBotList] = useState<Bot[]>([]);
  const [usage, setUsage] = useState<{ tokens: number; invocations: number; month: string } | null>(null);
  const [quota, setQuota] = useState<{ maxMonthlyTokens: number; maxBots: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [bots, me] = await Promise.all([botsApi.list(), userApi.me()]);
        setBotList(bots);
        if (me.usage) setUsage(me.usage);
        if (me.quota) setQuota(me.quota);
      } catch (err) {
        console.error('Failed to load dashboard:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-accent-500 border-t-transparent" />
      </div>
    );
  }

  const activeBots = botList.filter(b => b.status === 'active').length;

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Welcome */}
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{t('dashboard.title')}</h1>
        <p className="text-sm text-slate-500 mt-1">{t('dashboard.subtitle')}</p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          icon={BotIcon}
          label={t('dashboard.bots')}
          value={botList.length}
          subtitle={t('dashboard.active', { count: activeBots })}
        />
        <StatCard
          icon={Coins}
          label={t('dashboard.tokens')}
          value={usage?.tokens?.toLocaleString() || '0'}
          subtitle={t('dashboard.monthlyQuota', { quota: quota?.maxMonthlyTokens?.toLocaleString() || '—' })}
        />
        <StatCard
          icon={Zap}
          label={t('dashboard.invocations')}
          value={usage?.invocations || 0}
          subtitle={usage?.month || t('dashboard.thisMonth')}
        />
      </div>

      {/* Quick Actions */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          to="/memory"
          className="group flex items-center justify-between rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-all hover:shadow-md hover:border-accent-200"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-50">
              <BookOpen className="h-5 w-5 text-accent-600" />
            </div>
            <div>
              <p className="font-medium text-slate-900">{t('dashboard.sharedMemory')}</p>
              <p className="text-sm text-slate-500">{t('dashboard.sharedMemoryDesc')}</p>
            </div>
          </div>
          <ArrowRight className="h-5 w-5 text-slate-400 transition-transform group-hover:translate-x-1" />
        </Link>
      </div>

      {/* Bot overview (if no bots, show empty state) */}
      {botList.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-slate-300 p-12 text-center">
          <BotIcon className="mx-auto h-12 w-12 text-slate-300" />
          <h3 className="mt-4 text-lg font-medium text-slate-900">{t('dashboard.noBots')}</h3>
          <p className="mt-2 text-sm text-slate-500">{t('dashboard.noBotsDesc')}</p>
        </div>
      )}
    </div>
  );
}
