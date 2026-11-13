import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDate } from '../utils/date';
import { useLive, getYearSummary, listRecentTransactions, countGivers, countBatches } from '../services/repo';
import { generateFinancialInsight } from '../services/geminiService';
import { useAuth } from '../contexts/AuthContext';
import { TrendingUp, Users, Wallet, Archive, Sparkles } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const money = (n: number) => n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', currencyDisplay: 'narrowSymbol' });

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const year = new Date().getFullYear();
  const summary = useLive(() => getYearSummary(year), [year]);
  const recent = useLive(() => listRecentTransactions(8));
  const giversCount = useLive(countGivers);
  const batchesCount = useLive(countBatches);

  const [insight, setInsight] = useState<string>('Analyzing vault data...');
  useEffect(() => {
    if (!summary) return;
    if (summary.count > 0) {
      generateFinancialInsight(summary.total, summary.batches, summary.count).then(setInsight);
    } else {
      setInsight(`No donations recorded for ${year} yet. Start by adding a batch.`);
    }
  }, [summary, year]);

  // Months up to the current one, so the chart isn't padded with empty future months
  const thisMonth = new Date().getMonth();
  const chartData = (summary?.byMonth ?? []).slice(0, thisMonth + 1).map((amount, i) => ({ name: MONTHS[i], amount }));
  const hasChartData = chartData.some(d => d.amount > 0);

  return (
    <div className="space-y-4 animate-fade-in">
      <header>
        <h2 className="text-3xl font-bold text-gray-800">Vault Overview</h2>
        <p className="text-gray-500">Welcome back{user?.name ? `, ${user.name}` : ''}.</p>
      </header>

      {/* AI Insight Card */}
      <div className="bg-gradient-to-r from-church-900 to-church-500 rounded-3xl p-6 text-white shadow-xl relative overflow-hidden">
        <div className="relative z-10 flex items-start gap-4">
          <div className="p-3 bg-white/10 rounded-full backdrop-blur-sm">
            <Sparkles className="w-6 h-6 text-church-gold" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-blue-100 mb-1">AI Financial Assistant</h3>
            <p className="text-lg leading-relaxed font-medium">{insight}</p>
          </div>
        </div>
        <div className="absolute top-0 right-0 -mt-4 -mr-4 w-32 h-32 bg-white/10 rounded-full blur-2xl"></div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-3xl shadow-lg border border-gray-100 flex items-center gap-4">
          <div className="p-4 bg-green-100 text-green-600 rounded-2xl">
            <Wallet className="w-8 h-8" />
          </div>
          <div>
            <p className="text-sm text-gray-500 font-medium uppercase tracking-wider">{year} Vault Value</p>
            <p className="text-3xl font-bold text-gray-900">{summary ? money(summary.total) : '…'}</p>
            {summary && (
              <p className="text-xs text-gray-400 mt-0.5">
                {summary.count} donation{summary.count === 1 ? '' : 's'} in {summary.batches} batch{summary.batches === 1 ? '' : 'es'}
              </p>
            )}
          </div>
        </div>

        <div className="bg-white p-6 rounded-3xl shadow-lg border border-gray-100 flex items-center gap-4">
          <div className="p-4 bg-blue-100 text-church-900 rounded-2xl">
            <Users className="w-8 h-8" />
          </div>
          <div>
            <p className="text-sm text-gray-500 font-medium uppercase tracking-wider">Total Givers</p>
            <p className="text-3xl font-bold text-gray-900">{giversCount ?? '…'}</p>
          </div>
        </div>

        <div className="bg-white p-6 rounded-3xl shadow-lg border border-gray-100 flex items-center gap-4">
          <div className="p-4 bg-yellow-100 text-yellow-600 rounded-2xl">
            <Archive className="w-8 h-8" />
          </div>
          <div>
            <p className="text-sm text-gray-500 font-medium uppercase tracking-wider">Total Batches</p>
            <p className="text-3xl font-bold text-gray-900">{batchesCount ?? '…'}</p>
          </div>
        </div>
      </div>

      {/* Chart & recent */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white p-6 rounded-3xl shadow-xl border border-gray-100">
          <h3 className="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-church-500" />
            {year} by Month
          </h3>
          <div className="h-64">
            {hasChartData ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={12} />
                  <YAxis tickLine={false} axisLine={false} fontSize={12} tickFormatter={v => `$${(v / 1000).toFixed(v >= 1000 ? 1 : 2)}k`} width={56} />
                  <Tooltip
                    formatter={(v: number) => [money(v), 'Total']}
                    cursor={{ fill: '#f3f4f6' }}
                    contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  />
                  <Bar dataKey="amount" radius={[6, 6, 0, 0]} fill="#2a48a0" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400">No donations in {year} yet</div>
            )}
          </div>
        </div>

        <div className="bg-white p-6 rounded-3xl shadow-xl border border-gray-100">
          <h3 className="text-xl font-bold text-gray-800 mb-4">Latest Transactions</h3>
          <div className="overflow-y-auto max-h-64">
            {recent && recent.length > 0 ? (
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-400 uppercase">
                  <tr>
                    <th className="text-left font-medium pb-2">Txn #</th>
                    <th className="text-left font-medium pb-2">Giver</th>
                    <th className="text-left font-medium pb-2 hidden sm:table-cell">Date</th>
                    <th className="text-right font-medium pb-2">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {recent.map(t => (
                    <tr key={t.transactionNumber} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate('/history')}
                        title={`Batch #${t.batchNumber} · ${t.method}`}>
                      <td className="py-2 font-mono text-xs text-gray-500">{t.transactionNumber}</td>
                      <td className="py-2 text-gray-800">
                        {t.giverName}
                        {t.envelopeNumber > 1 && <span className="text-gray-400 text-xs"> #{t.envelopeNumber}</span>}
                      </td>
                      <td className="py-2 text-gray-500 text-xs hidden sm:table-cell">{formatDate(t.batchDate)}</td>
                      <td className="py-2 text-right">
                        <span className="font-bold text-church-900 bg-blue-50 px-2 py-0.5 rounded-md">{money(t.amount)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-center text-gray-400 py-10">{recent ? 'No recent activity.' : 'Loading…'}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
