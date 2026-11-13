import React, { useState, useEffect, useMemo } from 'react';
import { formatDate } from '../utils/date';
import { useLive, listBatches, listDonations, getGivers, finalizeBatch, unlockBatch, deleteBatch, signAsSecondTeller, batchLabel } from '../services/repo';
import { BatchStatus, PaymentMethod, BatchSource, UserRole, isProviderSource } from '../types';
import { getBatchProviderSummary } from '../services/giving/repo';
import { FileText, Lock, CheckCircle, Banknote, ScrollText, Unlock, AlertTriangle, X, ShieldAlert, Edit, Smartphone, CreditCard, Users, FileSpreadsheet, Trash2, Mail } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import AccountingReport, { ReportRef as AccountingRef } from './AccountingReport';
import EnvelopeReport, { ReportRef as EnvelopeRef } from './EnvelopeReport';
import DepositSlip, { ReportRef as DepositRef } from './DepositSlip';

const BatchHistory: React.FC = () => {
  const navigate = useNavigate();
  const { user, secondaryUser } = useAuth();
  const batches = useLive(listBatches);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [unlockReason, setUnlockReason] = useState('');
  const [isFinalizing, setIsFinalizing] = useState(false);
  
  // Modals State
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showUnlockModal, setShowUnlockModal] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [isEmailingAll, setIsEmailingAll] = useState(false);

  const accountingRef = React.useRef<AccountingRef>(null);
  const envelopeRef = React.useRef<EnvelopeRef>(null);
  const depositRef = React.useRef<DepositRef>(null);

  // Fetch donations for the active batch for audit calculations
  const donations = useLive(() => selectedBatchId ? listDonations(selectedBatchId) : Promise.resolve([]), [selectedBatchId]);
  const giverKey = [...new Set((donations ?? []).map(d => d.giverId))].sort().join(',');
  const giverList = useLive(() => giverKey ? getGivers(giverKey.split(',')) : Promise.resolve([]), [giverKey]);
  const giverLabel = (id: string) => {
    const g = giverList?.find(x => x.id === id);
    return g ? `${g.name}${g.envelopeNumber > 1 ? ` (#${g.envelopeNumber})` : ''}` : '…';
  };

  const activeBatch = batches?.find(b => b.id === selectedBatchId);
  const providerSummary = useLive(
    () => activeBatch && isProviderSource(activeBatch.source) ? getBatchProviderSummary(activeBatch.id!) : Promise.resolve(null),
    [activeBatch?.id, activeBatch?.source, activeBatch?.totalAmount]);

  // Auto-select latest batch on load
  useEffect(() => {
    if (batches && batches.length > 0 && selectedBatchId === null) {
      setSelectedBatchId(batches[0].id!);
    }
  }, [batches, selectedBatchId]);

  // --- Audit State ---
  const [cashCounts, setCashCounts] = useState<Record<string, number>>({
    '100': 0, '50': 0, '20': 0, '10': 0, '5': 0, '2': 0, '1': 0, '0.25': 0, '0.10': 0, '0.05': 0
  });
  const [userCheckCount, setUserCheckCount] = useState<string>('');
  const [userCheckAmount, setUserCheckAmount] = useState<string>('');

  // Reset state on batch change
  useEffect(() => {
    setCashCounts({ '100': 0, '50': 0, '20': 0, '10': 0, '5': 0, '2': 0, '1': 0, '0.25': 0, '0.10': 0, '0.05': 0 });
    setUserCheckCount('');
    setUserCheckAmount('');
    setShowConfirmModal(false);
    setAuditError(null);
  }, [selectedBatchId]);

  // --- Calculations ---
  
  // System Totals
  const systemCheckDonations = donations?.filter(d => d.paymentMethod === PaymentMethod.Cheque) || [];
  const systemCheckCount = systemCheckDonations.length;
  const systemCheckTotal = systemCheckDonations.reduce((sum, d) => sum + d.amount, 0);

  // Cash Calculations
  const systemCashTotal = donations?.filter(d => d.paymentMethod === PaymentMethod.Cash).reduce((sum, d) => sum + d.amount, 0) || 0;
  
  // Calculate System Denomination Counts (Aggregation)
  const DENOMINATIONS = [100, 50, 20, 10, 5, 2, 1, 0.25, 0.10, 0.05];
  const systemDenomCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    DENOMINATIONS.forEach(d => counts[d.toString()] = 0);
    
    donations?.forEach(d => {
      if (d.paymentMethod === PaymentMethod.Cash && d.cashCounts) {
        Object.entries(d.cashCounts).forEach(([denom, count]) => {
          counts[denom] = (counts[denom] || 0) + Number(count);
        });
      }
    });
    return counts;
  }, [donations]);

  // User Totals
  const countedCashTotal = Object.entries(cashCounts).reduce((acc, [denom, count]) => {
    return acc + (parseFloat(denom) * Number(count));
  }, 0);
  
  // Variances
  const cashDiff = countedCashTotal - systemCashTotal;
  const isCashTotalBalanced = Math.abs(cashDiff) < 0.01;
  
  // Strict Denomination Check
  const countMismatches = DENOMINATIONS.filter(d => {
    const sys = systemDenomCounts[d.toString()] || 0;
    const usr = cashCounts[d.toString()] || 0;
    return sys !== usr;
  });
  const isCashCountsBalanced = countMismatches.length === 0;

  const isCashBalanced = isCashTotalBalanced && isCashCountsBalanced;
  
  const checkCountDiff = (parseInt(userCheckCount || '0')) - systemCheckCount;
  const checkAmountDiff = (parseFloat(userCheckAmount || '0')) - systemCheckTotal;
  const isCheckCountBalanced = checkCountDiff === 0;
  const isCheckAmountBalanced = Math.abs(checkAmountDiff) < 0.01;
  const isCheckBalanced = isCheckCountBalanced && isCheckAmountBalanced;

  const isReadyToFinalize = isCashBalanced && isCheckBalanced;

  // --- Actions ---

  const handleFinalizeClick = () => {
    if (!selectedBatchId) return;
    
    if (!isReadyToFinalize) {
      let errors = [];
      if (!isCashTotalBalanced) {
        errors.push(`Cash value variance of $${cashDiff.toFixed(2)} detected.`);
      } else if (!isCashCountsBalanced) {
        errors.push(`Cash value balanced, but denomination counts do not match expected system records.`);
      }
      
      if (!isCheckCountBalanced) errors.push(`Cheque count mismatch (Off by ${checkCountDiff > 0 ? '+' : ''}${checkCountDiff}).`);
      if (!isCheckAmountBalanced) errors.push(`Cheque amount mismatch (Off by $${checkAmountDiff > 0 ? '+' : ''}${checkAmountDiff.toFixed(2)}).`);
      
      setAuditError(errors.join(' '));
      return;
    }

    setShowConfirmModal(true);
  };

  const executeFinalization = async () => {
    if (selectedBatchId) {
      setIsFinalizing(true);
      try {
        // The second teller signs with their own session first; then the
        // server re-runs the blind audit and the dual-control rule before locking.
        if (secondaryUser) {
          await signAsSecondTeller(selectedBatchId);
        }
        await finalizeBatch(selectedBatchId, cashCounts,
          parseInt(userCheckCount || '0'), parseFloat(userCheckAmount || '0'));
        setShowConfirmModal(false);
      } catch (err: any) {
        console.error("Failed to finalize", err);
        setShowConfirmModal(false);
        setAuditError(err.message || "System error occurred while finalizing batch.");
      } finally {
        setIsFinalizing(false);
      }
    }
  };

  const executeUnlock = async () => {
    if (selectedBatchId && user?.role === UserRole.Administrator) {
      if (!unlockReason.trim()) return;
      try {
        await unlockBatch(selectedBatchId, unlockReason.trim());
        setShowUnlockModal(false);
        setUnlockReason('');
      } catch (err: any) {
        console.error("Failed to unlock", err);
        setShowUnlockModal(false);
        setAuditError(err.message || "System error occurred while unlocking batch.");
      }
    }
  };

  const handleDeleteBatch = async () => {
    if (selectedBatchId) {
      try {
        await deleteBatch(selectedBatchId);
        setSelectedBatchId(null);
        setShowDeleteModal(false);
      } catch (err: any) {
        console.error("Failed to delete batch", err);
        setAuditError(err.message || "System error occurred while deleting batch.");
      }
    }
  };

  const handleEmailAll = async () => {
    if (!accountingRef.current || !envelopeRef.current || !depositRef.current) return;
    setIsEmailingAll(true);
    try {
      await accountingRef.current.sendEmail();
      await envelopeRef.current.sendEmail();
      await depositRef.current.sendEmail();
      alert('All reports emailed successfully!');
    } catch (err: any) {
      console.error("Failed to email all reports:", err);
      alert("Failed to email some or all reports. Check console for details.");
    } finally {
      setIsEmailingAll(false);
    }
  };

  // Helper for source icon
  const getSourceIcon = (source: BatchSource) => {
    switch (source) {
        case BatchSource.ETransfer: return <Smartphone className="w-3 h-3" />;
        case BatchSource.PushPay:
        case BatchSource.Stripe: return <CreditCard className="w-3 h-3" />;
        default: return <Users className="w-3 h-3" />;
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col -mx-4 px-4 overflow-hidden">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 flex-1 min-h-0 pb-4">
        {/* Left: Batch List */}
        <div className="lg:col-span-4 h-full flex flex-col min-h-0 pr-2">
          <div className="pb-3 shrink-0">
            <h2 className="text-3xl font-bold text-gray-800">Batch History</h2>
          </div>
          <div className="space-y-2 overflow-y-scroll flex-1 pb-4 pr-1">
            {batches?.map(batch => (
              <div 
                key={batch.id} 
                onClick={() => setSelectedBatchId(batch.id || null)}
                className={`p-3 rounded-xl cursor-pointer transition-all ${
                  selectedBatchId === batch.id 
                    ? 'bg-church-900 text-white shadow-xl scale-[1.02] border border-church-900' 
                    : 'bg-white hover:bg-blue-50 border border-gray-400'
                }`}
              >
                <div className="flex justify-between items-center mb-2">
                  <span className="font-bold">Batch #{batchLabel(batch)}</span>
                  <span className={`text-xs px-2 py-1 rounded-full font-bold ${
                    batch.status === BatchStatus.Finalized ? 'bg-green-400 text-green-900' : 'bg-yellow-400 text-yellow-900'
                  }`}>
                    {batch.status}
                  </span>
                </div>
                
                <div className={`flex items-center gap-1 text-xs mb-2 ${selectedBatchId === batch.id ? 'text-blue-200' : 'text-gray-400'}`}>
                   {getSourceIcon(batch.source)} {batch.source}
                </div>

                <div className="flex justify-between text-sm opacity-80">
                  <span>{formatDate(batch.date)}</span>
                  <span className="font-mono font-bold">${batch.totalAmount.toFixed(2)}</span>
                </div>
              </div>
            ))}
            {(!batches || batches.length === 0) && <p className="text-gray-400 text-center py-10">No batches found.</p>}
          </div>
        </div>

        {/* Right: Audit & Details */}
        <div className="lg:col-span-8 bg-white rounded-3xl shadow-xl border border-gray-100 flex flex-col overflow-hidden h-full min-h-0">
          {activeBatch ? (
            <div className="flex flex-col h-full min-h-0">
               {/* Header */}
               <div className="p-4 border-b border-gray-100 bg-gray-50/50 shrink-0 flex flex-col gap-3">
                 
                 {/* Line 1: Title and Actions */}
                 <div className="flex justify-between items-start md:items-center gap-4">
                   <h3 className="text-2xl font-bold text-gray-800">Batch #{batchLabel(activeBatch)}</h3>
                   
                   {/* Hidden Reports for Emailing */}
                   <div style={{ position: 'absolute', top: '-9999px', left: '-9999px', width: '1024px' }}>
                     <AccountingReport ref={accountingRef} batchIdProp={activeBatch.id} hiddenMode={true} />
                     <EnvelopeReport ref={envelopeRef} batchIdProp={activeBatch.id} hiddenMode={true} />
                     <DepositSlip ref={depositRef} batchIdProp={activeBatch.id} hiddenMode={true} />
                   </div>

                   <div className="flex flex-wrap items-center gap-2">
                     {activeBatch.status === BatchStatus.Open ? (
                       <>
                        <button 
                          onClick={() => setShowDeleteModal(true)}
                          className="p-1.5 rounded-lg bg-white border border-red-100 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors shadow-sm"
                          title="Delete Batch"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => navigate(`/batch-entry?batchId=${activeBatch.id}`)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold bg-white border border-gray-400 text-gray-700 hover:bg-gray-100 shadow-sm transition-colors"
                        >
                          <Edit className="w-4 h-4" /> Edit Batch
                        </button>
                        <button 
                          onClick={handleFinalizeClick}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm shadow-sm transition-all font-bold ${
                            isReadyToFinalize 
                              ? 'bg-green-600 hover:bg-green-700 text-white animate-pulse' 
                              : 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200 border border-yellow-300'
                          }`}
                        >
                           {isReadyToFinalize ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
                           {isReadyToFinalize ? 'Finalize Batch' : 'Audit Incomplete'}
                        </button>
                       </>
                     ) : (
                       <>
                         <button 
                           onClick={() => setShowDeleteModal(true)}
                           className="p-1.5 rounded-lg bg-white border border-red-100 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors shadow-sm"
                           title="Delete Batch"
                         >
                           <Trash2 className="w-4 h-4" />
                         </button>
                         {user?.role === UserRole.Administrator && (
                           <button 
                             onClick={() => setShowUnlockModal(true)}
                             className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold bg-white border border-yellow-400 text-yellow-700 hover:bg-yellow-50 shadow-sm transition-colors"
                             title="Unlock Batch (Admin Only)"
                           >
                             <Unlock className="w-4 h-4" /> Unlock
                           </button>
                         )}
                         <div className="flex items-center gap-1.5 text-green-700 bg-green-100 px-3 py-1.5 rounded-lg text-sm font-bold border border-green-200 shadow-sm">
                           <CheckCircle className="w-4 h-4" /> Batch Locked
                         </div>
                       </>
                     )}
                   </div>
                 </div>

                 {/* Line 2: Details */}
                 <div className="flex flex-wrap items-center gap-4 text-sm text-gray-600">
                    <span className="flex items-center gap-1 bg-white px-2 py-1 rounded-md border border-gray-200 text-xs font-bold text-gray-600 shadow-sm">
                        {getSourceIcon(activeBatch.source)} {activeBatch.source}
                    </span>
                    <span className="text-gray-500">Date: <span className="font-semibold text-gray-800">{formatDate(activeBatch.date)}</span></span>
                    <div className="w-px h-4 bg-gray-200"></div>
                    <span className="text-gray-500">Total: <span className="font-bold text-church-900">${activeBatch.totalAmount.toFixed(2)}</span></span>
                 </div>

                 {/* Line 3: Reports Row */}
                 <div className="flex flex-wrap items-center gap-1.5 pt-3 border-t border-gray-200/50">
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mr-1">Reports:</span>
                    <button 
                      onClick={() => navigate(`/reports/accounting/${activeBatch.id}`)}
                      className="flex items-center gap-1 px-2 py-1 bg-white border border-gray-300 text-gray-600 font-bold rounded-md hover:bg-blue-50 hover:text-blue-700 hover:border-blue-400 transition-colors text-xs shadow-sm"
                    >
                      <FileSpreadsheet className="w-3.5 h-3.5" /> Accounting
                    </button>
                    <button 
                      onClick={() => navigate(`/reports/envelope/${activeBatch.id}`)}
                      className="flex items-center gap-1 px-2 py-1 bg-white border border-gray-300 text-gray-600 font-bold rounded-md hover:bg-blue-50 hover:text-blue-700 hover:border-blue-400 transition-colors text-xs shadow-sm"
                    >
                      <Users className="w-3.5 h-3.5" /> Envelope
                    </button>
                    {activeBatch.status === BatchStatus.Finalized && (
                      <button 
                        onClick={() => navigate(`/reports/deposit-slip/${activeBatch.id}`)}
                        className="flex items-center gap-1 px-2 py-1 bg-white border border-gray-300 text-gray-600 font-bold rounded-md hover:bg-blue-50 hover:text-blue-700 hover:border-blue-400 transition-colors text-xs shadow-sm"
                      >
                        <ScrollText className="w-3.5 h-3.5" /> Deposit Slip
                      </button>
                    )}
                    
                    {activeBatch.status === BatchStatus.Finalized && (
                       <button
                         onClick={handleEmailAll}
                         disabled={isEmailingAll}
                         className="ml-auto flex items-center gap-1.5 px-3 py-1 bg-white border border-gray-300 text-church-600 hover:text-church-800 font-bold rounded-md disabled:opacity-50 transition-colors text-xs shadow-sm"
                       >
                         <Mail className="w-3.5 h-3.5" /> {isEmailingAll ? 'Sending...' : 'Email All Reports'}
                       </button>
                    )}
                 </div>
               </div>

               {/* Audit Workspace */}
               <div className="flex-1 overflow-y-auto p-4 space-y-4">
                 {activeBatch.status === BatchStatus.Finalized ? (
                   <div className="flex flex-col items-center justify-center h-full text-gray-400 space-y-4 py-12">
                     <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center">
                       <Lock className="w-10 h-10 text-gray-300" />
                     </div>
                     <p className="text-xl font-bold text-gray-500">Batch Finalized</p>
                     <p className="text-sm text-gray-400">Audit details are hidden for finalized batches. Use the reports above to view batch data.</p>
                   </div>
                 ) : (
                   <>
                     {providerSummary && (
                       <div className="p-4 rounded-xl border-2 bg-blue-50/40 border-blue-200" data-testid="provider-reconcile">
                         <h4 className="text-lg font-bold text-gray-700 flex items-center gap-2 mb-1">
                           <CreditCard className="w-5 h-5 text-church-500" /> {activeBatch.source} reconciliation
                         </h4>
                         <p className="text-sm text-gray-500 mb-3">
                           Second person: check these figures against the {activeBatch.source} deposit report and the bank statement before signing.
                         </p>
                         <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
                           <div className="bg-white rounded-lg border p-2"><div className="text-xs text-gray-400">Gifts</div><div className="text-lg font-bold">{providerSummary.count}</div></div>
                           <div className="bg-white rounded-lg border p-2"><div className="text-xs text-gray-400">Gross (receipted)</div><div className="text-lg font-bold">${providerSummary.gross.toFixed(2)}</div></div>
                           <div className="bg-white rounded-lg border p-2"><div className="text-xs text-gray-400">Processing fees</div><div className="text-lg font-bold text-red-600">-${providerSummary.fees.toFixed(2)}</div></div>
                           <div className="bg-white rounded-lg border p-2"><div className="text-xs text-gray-400">Expected bank deposit</div><div className="text-lg font-bold text-green-700">${providerSummary.net.toFixed(2)}</div></div>
                         </div>
                         {Math.abs(providerSummary.gross - activeBatch.totalAmount) >= 0.01 && (
                           <p className="mt-3 text-sm text-amber-700 flex gap-1"><AlertTriangle className="w-4 h-4" /> This batch was edited after import: its total (${activeBatch.totalAmount.toFixed(2)}) differs from the imported gifts.</p>
                         )}
                         {providerSummary.refunded > 0 && (
                           <p className="mt-3 text-sm text-red-700 flex gap-1"><AlertTriangle className="w-4 h-4" /> {providerSummary.refunded} gift(s) in this batch were refunded in {activeBatch.source} after import. Remove them before finalizing.</p>
                         )}
                       </div>
                     )}
                     {!(isProviderSource(activeBatch.source) && systemCashTotal === 0 && systemCheckCount === 0) && (<>
                     {/* Cash Audit Section */}
                     <div className={`p-4 rounded-xl border-2 transition-colors ${isCashBalanced ? 'bg-green-50/30 border-green-200' : 'bg-red-50/30 border-red-200'}`}>
                        <div className="flex justify-between items-center mb-3">
                          <h4 className="text-lg font-bold text-gray-700 flex items-center gap-2">
                            <Banknote className="w-5 h-5 text-church-500" /> Cash Audit
                          </h4>
                          <div className={`text-base px-3 py-1 rounded-lg font-bold ${isCashBalanced ? 'text-green-700 bg-green-100' : 'text-red-600 bg-red-100'}`}>
                             {isCashBalanced 
                               ? 'Balanced' 
                               : (isCashTotalBalanced ? 'Count Mismatch' : `Variance: ${cashDiff > 0 ? '+' : ''}${cashDiff.toFixed(2)}`)
                             }
                          </div>
                        </div>

                        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
                          {DENOMINATIONS.map(denom => {
                            const sysCount = systemDenomCounts[denom.toString()] || 0;
                            const userCount = cashCounts[denom.toString()] || 0;
                            const match = sysCount === userCount;
                            
                            return (
                              <div key={denom} className="relative">
                                <label className="text-sm font-bold text-gray-400 block mb-0.5 text-center">${denom}</label>
                                <input 
                                  type="number" 
                                  min="0"
                                  disabled={activeBatch.status === BatchStatus.Finalized}
                                  className={`w-full p-1 rounded-lg border text-base text-center outline-none focus:ring-2 focus:ring-church-500 font-bold ${match ? 'bg-white border-gray-400 text-gray-800' : 'bg-red-50 border-red-300 text-red-600'}`}
                                  value={cashCounts[denom.toString()] || ''}
                                  onChange={(e) => setCashCounts({...cashCounts, [denom.toString()]: parseInt(e.target.value) || 0})}
                                />
                                {/* Expected Count Indicator if mismatch and strictly auditing */}
                                {(!match && activeBatch.status === BatchStatus.Open) && (
                                  <div className="text-xs text-center text-gray-400 mt-1 font-bold">Exp: {sysCount}</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        
                        <div className="flex justify-between items-center mt-3 pt-3 border-t border-gray-200/50">
                           <div className="text-base text-gray-500">System Recorded: <span className="font-bold">${systemCashTotal.toFixed(2)}</span></div>
                           <div className="text-xl text-gray-800">Counted: <span className="font-bold">${countedCashTotal.toFixed(2)}</span></div>
                        </div>
                     </div>

                     {/* Check Audit Section */}
                     <div className={`p-4 rounded-xl border-2 transition-colors ${isCheckBalanced ? 'bg-green-50/30 border-green-200' : 'bg-red-50/30 border-red-200'}`}>
                        <div className="flex justify-between items-center mb-3">
                          <h4 className="text-lg font-bold text-gray-700 flex items-center gap-2">
                            <FileText className="w-5 h-5 text-church-500" /> Cheque Audit
                          </h4>
                          <div className={`text-base px-3 py-1 rounded-lg font-bold ${isCheckBalanced ? 'text-green-700 bg-green-100' : 'text-red-600 bg-red-100'}`}>
                             {isCheckBalanced ? 'Balanced' : (!isCheckCountBalanced ? `Count Variance: ${checkCountDiff > 0 ? '+' : ''}${checkCountDiff}` : `Amount Variance: $${checkAmountDiff > 0 ? '+' : ''}${checkAmountDiff.toFixed(2)}`)}
                          </div>
                        </div>

                        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                          <table className="w-full text-left">
                            <thead className="bg-gray-50 text-gray-500 text-base font-medium">
                              <tr>
                                <th className="p-2 pl-4 w-1/3">Type</th>
                                <th className="p-2 w-1/3">Audit Total</th>
                                <th className="p-2 pr-4 text-right w-1/3">System Total</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 text-base">
                              <tr className="hover:bg-gray-50/50 transition-colors">
                                <td className="p-2 pl-4 font-bold text-gray-700">Physical Cheques</td>
                                <td className="p-2">
                                  <input 
                                    type="number" 
                                    placeholder="Count..."
                                    className="w-full max-w-[180px] p-1.5 rounded-lg border border-gray-400 font-bold bg-white focus:ring-2 focus:ring-church-500 outline-none text-base"
                                    value={userCheckCount}
                                    onChange={(e) => setUserCheckCount(e.target.value)}
                                  />
                                </td>
                                <td className="p-2 pr-4 text-right text-xl font-bold text-gray-800">{systemCheckCount}</td>
                              </tr>
                              <tr className="hover:bg-gray-50/50 transition-colors">
                                <td className="p-2 pl-4 font-bold text-gray-700">Total Amount</td>
                                <td className="p-2">
                                  <div className="relative max-w-[180px]">
                                    <span className="absolute left-3 top-2 text-gray-400 font-bold">$</span>
                                    <input 
                                      type="number" 
                                      step="0.01"
                                      placeholder="0.00"
                                      className="w-full pl-7 p-1.5 rounded-lg border border-gray-400 font-bold bg-white focus:ring-2 focus:ring-church-500 outline-none text-base"
                                      value={userCheckAmount}
                                      onChange={(e) => setUserCheckAmount(e.target.value)}
                                    />
                                  </div>
                                </td>
                                <td className="p-2 pr-4 text-right text-xl font-bold text-church-900">${systemCheckTotal.toFixed(2)}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>

                        {/* Deposit Slip / Check List */}
                        <div className="mt-4">
                           <h5 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                             <ScrollText className="w-3 h-3" /> Deposit Summary (Cheques)
                           </h5>
                           <div className="bg-white rounded-xl border border-gray-200 overflow-hidden max-h-40 overflow-y-auto">
                             <table className="w-full text-sm text-left">
                               <thead className="bg-gray-50 text-gray-500">
                                 <tr>
                                   <th className="p-2 pl-4">Txn #</th>
                                   <th className="p-2">Cheque #</th>
                                   <th className="p-2">Giver</th>
                                   <th className="p-2 text-right pr-4">Amount</th>
                                 </tr>
                               </thead>
                               <tbody>
                                 {systemCheckDonations.map(d => (
                                   <tr key={d.id} className="border-b border-gray-50 last:border-0 hover:bg-blue-50">
                                     <td className="p-2 pl-4 font-mono text-xs text-gray-400">{d.transactionNumber}</td>
                                     <td className="p-2 font-mono text-gray-600">{d.chequeNumber || '-'}</td>
                                     <td className="p-2 text-gray-500">{giverLabel(d.giverId)}</td>
                                     <td className="p-2 text-right pr-4 font-medium">${d.amount.toFixed(2)}</td>
                                   </tr>
                                 ))}
                                 {systemCheckDonations.length === 0 && (
                                   <tr><td colSpan={3} className="p-4 text-center text-gray-400">No cheques in this batch.</td></tr>
                                 )}
                               </tbody>
                             </table>
                           </div>
                        </div>
                     </div>
                     </>)}
                   </>
                 )}
               </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-400">
              <div className="p-6 bg-gray-50 rounded-full mb-4">
                <FileText className="w-10 h-10 opacity-50" />
              </div>
              <p className="font-medium">Select a batch to begin audit.</p>
            </div>
          )}
        </div>
      </div>

      {/* --- Confirmation Modal --- */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl animate-fade-in-up border border-gray-100">
            <div className="flex flex-col items-center text-center">
               <div className="w-16 h-16 bg-yellow-100 rounded-full flex items-center justify-center mb-4">
                 <Lock className="w-8 h-8 text-yellow-600" />
               </div>
               <h3 className="text-xl font-bold text-gray-800 mb-2">Finalize Batch #{batchLabel(activeBatch)}?</h3>
               <p className="text-gray-500 mb-6 text-sm">
                 This action will <strong>permanently lock</strong> these donations and the audit record. You cannot edit this batch after finalizing.
               </p>
               <div className="flex gap-3 w-full">
                 <button 
                   onClick={() => setShowConfirmModal(false)}
                   className="flex-1 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition-colors"
                 >
                   Cancel
                 </button>
                 <button 
                   onClick={executeFinalization}
                   disabled={isFinalizing}
                   className="flex-1 py-3 bg-church-900 text-white font-bold rounded-xl hover:bg-church-800 shadow-lg transition-transform active:scale-95 disabled:opacity-50"
                 >
                   {isFinalizing ? 'Locking…' : 'Confirm & Lock'}
                 </button>
               </div>
            </div>
          </div>
        </div>
      )}

      {/* --- Delete Confirmation Modal --- */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl animate-fade-in-up border border-red-100">
            <div className="flex flex-col items-center text-center">
               <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-4">
                 <AlertTriangle className="w-8 h-8 text-red-600" />
               </div>
               <h3 className="text-xl font-bold text-gray-800 mb-2">Delete Batch #{batchLabel(activeBatch)}?</h3>
               <p className="text-gray-500 mb-6 text-sm">
                 Are you sure you want to delete this batch? This action <strong>cannot be undone</strong> and will remove all associated donation records.
               </p>
               <div className="flex gap-3 w-full">
                 <button 
                   onClick={() => setShowDeleteModal(false)}
                   className="flex-1 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition-colors"
                 >
                   Cancel
                 </button>
                 <button 
                   onClick={handleDeleteBatch}
                   className="flex-1 py-3 bg-red-600 text-white font-bold rounded-xl hover:bg-red-700 shadow-lg transition-transform active:scale-95"
                 >
                   Delete Forever
                 </button>
               </div>
            </div>
          </div>
        </div>
      )}

      {/* --- Unlock Confirmation Modal --- */}
      {showUnlockModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl animate-fade-in-up border border-yellow-100">
            <div className="flex flex-col items-center text-center">
               <div className="w-16 h-16 bg-yellow-100 rounded-full flex items-center justify-center mb-4">
                 <Unlock className="w-8 h-8 text-yellow-600" />
               </div>
               <h3 className="text-xl font-bold text-gray-800 mb-2">Unlock Batch #{batchLabel(activeBatch)}?</h3>
               <p className="text-gray-500 mb-4 text-sm">
                 This reopens the batch for editing. The original tellers' sign-offs stay on record,
                 and an administrator must sign off when it is finalized again.
               </p>
               <textarea
                 className="w-full p-3 mb-6 rounded-xl border border-gray-300 text-sm focus:ring-2 focus:ring-yellow-500 outline-none"
                 rows={2}
                 placeholder="Reason for the adjustment (required, kept in the audit log)"
                 value={unlockReason}
                 onChange={e => setUnlockReason(e.target.value)}
               />
               <div className="flex gap-3 w-full">
                 <button 
                   onClick={() => setShowUnlockModal(false)}
                   className="flex-1 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition-colors"
                 >
                   Cancel
                 </button>
                 <button 
                   onClick={executeUnlock}
                   disabled={!unlockReason.trim()}
                   className="flex-1 py-3 disabled:opacity-50 bg-yellow-600 text-white font-bold rounded-xl hover:bg-yellow-700 shadow-lg transition-transform active:scale-95"
                 >
                   Confirm Unlock
                 </button>
               </div>
            </div>
          </div>
        </div>
      )}

      {/* --- Error Modal --- */}
      {auditError && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl animate-fade-in-up border border-red-100">
            <div className="flex flex-col items-center text-center">
               <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-4">
                 <ShieldAlert className="w-8 h-8 text-red-500" />
               </div>
               <h3 className="text-xl font-bold text-gray-800 mb-2">Audit Failed</h3>
               <p className="text-red-500 font-medium mb-6 text-sm bg-red-50 p-4 rounded-xl border border-red-100 w-full">
                 {auditError}
               </p>
               <button 
                 onClick={() => setAuditError(null)}
                 className="w-full py-3 bg-gray-100 text-gray-700 font-bold rounded-xl hover:bg-gray-200 transition-colors"
               >
                 Review Counts
               </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BatchHistory;
