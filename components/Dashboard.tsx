import React, { useEffect, useState } from 'react';
import { useLive, listAllDonations, countGivers, countBatches } from '../services/repo';
import { generateFinancialInsight } from '../services/geminiService';
import { Donation } from '../types';
import { TrendingUp, Users, Wallet, Archive, Sparkles } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

const Dashboard: React.FC = () => {
  const donations = useLive(listAllDonations);
  const giversCount = useLive(countGivers);
  const batchesCount = useLive(countBatches);
  
  const [insight, setInsight] = useState<string>("Analyzing vault data...");
  const [totalValue, setTotalValue] = useState(0);

  useEffect(() => {
    if (donations) {
      const total = donations.reduce((sum, d) => sum + d.amount, 0);
      setTotalValue(total);

      // Only call AI if we have data to analyze to save tokens/calls
      if (donations.length > 0) {
        generateFinancialInsight(total, batchesCount || 0, donations.length)
          .then(setInsight);
      } else {
        setInsight("Vault is empty. Start by adding a batch.");
      }
    }
  }, [donations, batchesCount]);

  // Prepare chart data (Last 5 donations for visual)
  const chartData = donations?.slice(-7).map((d, i) => ({
    name: `Tx ${i + 1}`,
    amount: d.amount,
  })) || [];

  return (
    <div className="space-y-8 animate-fade-in">
      <header>
        <h2 className="text-3xl font-bold text-gray-800">Vault Overview</h2>
        <p className="text-gray-500">Welcome back, Treasurer.</p>
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

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-3xl shadow-lg border border-gray-100 flex items-center gap-4">
          <div className="p-4 bg-green-100 text-green-600 rounded-2xl">
            <Wallet className="w-8 h-8" />
          </div>
          <div>
            <p className="text-sm text-gray-500 font-medium uppercase tracking-wider">Vault Value</p>
            <p className="text-3xl font-bold text-gray-900">
              ${totalValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </p>
          </div>
        </div>

        <div className="bg-white p-6 rounded-3xl shadow-lg border border-gray-100 flex items-center gap-4">
          <div className="p-4 bg-blue-100 text-church-900 rounded-2xl">
            <Users className="w-8 h-8" />
          </div>
          <div>
            <p className="text-sm text-gray-500 font-medium uppercase tracking-wider">Total Givers</p>
            <p className="text-3xl font-bold text-gray-900">{giversCount || 0}</p>
          </div>
        </div>

        <div className="bg-white p-6 rounded-3xl shadow-lg border border-gray-100 flex items-center gap-4">
          <div className="p-4 bg-yellow-100 text-yellow-600 rounded-2xl">
            <Archive className="w-8 h-8" />
          </div>
          <div>
            <p className="text-sm text-gray-500 font-medium uppercase tracking-wider">Total Batches</p>
            <p className="text-3xl font-bold text-gray-900">{batchesCount || 0}</p>
          </div>
        </div>
      </div>

      {/* Recent Activity & Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white p-6 rounded-3xl shadow-xl border border-gray-100">
          <h3 className="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-church-500" />
            Recent Donations
          </h3>
          <div className="h-64">
             {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <XAxis dataKey="name" hide />
                    <YAxis />
                    <Tooltip 
                      cursor={{fill: '#f3f4f6'}}
                      contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                    />
                    <Bar dataKey="amount" radius={[6, 6, 0, 0]}>
                      {chartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill="#2a48a0" />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
             ) : (
                <div className="flex items-center justify-center h-full text-gray-400">No data yet</div>
             )}
          </div>
        </div>

        <div className="bg-white p-6 rounded-3xl shadow-xl border border-gray-100">
           <h3 className="text-xl font-bold text-gray-800 mb-4">Latest Transactions</h3>
           <div className="overflow-y-auto max-h-64 space-y-3">
             {donations?.slice().reverse().slice(0, 5).map(d => (
               <div key={d.id} className="flex justify-between items-center p-3 hover:bg-gray-50 rounded-xl transition-colors border-b border-gray-50 last:border-0">
                 <div>
                   <p className="font-semibold text-gray-800">Donation #{d.id}</p>
                   <p className="text-xs text-gray-500">{new Date(d.date).toLocaleDateString()}</p>
                 </div>
                 <span className="font-bold text-church-900 bg-blue-50 px-3 py-1 rounded-lg">
                   ${d.amount.toFixed(2)}
                 </span>
               </div>
             ))}
             {(!donations || donations.length === 0) && (
                <p className="text-center text-gray-400 py-10">No recent activity.</p>
             )}
           </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;