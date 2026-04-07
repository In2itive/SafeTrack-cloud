import React, { useState, useEffect, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../services/db';
import { BatchStatus, PaymentMethod, BatchSource, UserRole } from '../types';
import { FileText, Lock, CheckCircle, Banknote, ScrollText, Unlock, AlertTriangle, X, ShieldAlert, Edit, Smartphone, CreditCard, Users, FileSpreadsheet, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const BatchHistory: React.FC = () => {
  const navigate = useNavigate();
  const { user, secondaryUser } = useAuth();
  const batches = useLiveQuery(() => db.batches.orderBy('date').reverse().toArray());
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  
  // Modals State
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showUnlockModal, setShowUnlockModal] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  // Fetch donations for the active batch for audit calculations
  const donations = useLiveQuery(() => 
    selectedBatchId ? db.donations.where('batchId').equals(selectedBatchId).toArray() : Promise.resolve([])
  , [selectedBatchId]);

  const activeBatch = batches?.find(b => b.id === selectedBatchId);

  // --- Audit State ---
  const [cashCounts, setCashCounts] = useState<Record<string, number>>({
    '100': 0, '50': 0, '20': 0, '10': 0, '5': 0, '2': 0, '1': 0, '0.25': 0, '0.10': 0, '0.05': 0
  });
  const [userCheckCount, setUserCheckCount] = useState<string>('');

  // Reset state on batch change
  useEffect(() => {
    setCashCounts({ '100': 0, '50': 0, '20': 0, '10': 0, '5': 0, '2': 0, '1': 0, '0.25': 0, '0.10': 0, '0.05': 0 });
    setUserCheckCount('');
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
  const isCheckBalanced = checkCountDiff === 0;

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
      
      if (!isCheckBalanced) errors.push(`Cheque count mismatch (Off by ${checkCountDiff > 0 ? '+' : ''}${checkCountDiff}).`);
      
      setAuditError(errors.join(' '));
      return;
    }

    setShowConfirmModal(true);
  };

  const executeFinalization = async () => {
    if (selectedBatchId) {
      try {
        const finalizedBy = [user?.name || 'Unknown'];
        if (secondaryUser) {
          finalizedBy.push(secondaryUser.name);
        }
        await db.batches.update(selectedBatchId, { 
          status: BatchStatus.Finalized,
          finalizedBy
        });
        setShowConfirmModal(false);
      } catch (err) {
        console.error("Failed to finalize", err);
        setAuditError("System error occurred while updating batch.");
      }
    }
  };

  const executeUnlock = async () => {
    if (selectedBatchId && user?.role === UserRole.Administrator) {
      try {
        await db.batches.update(selectedBatchId, { status: BatchStatus.Open });
        setShowUnlockModal(false);
      } catch (err) {
        console.error("Failed to unlock", err);
        setAuditError("System error occurred while unlocking batch.");
      }
    }
  };

  const handleDeleteBatch = async () => {
    if (selectedBatchId) {
      try {
        await db.transaction('rw', db.batches, db.donations, async () => {
          await db.donations.where('batchId').equals(selectedBatchId).delete();
          await db.batches.delete(selectedBatchId);
        });
        setSelectedBatchId(null);
        setShowDeleteModal(false);
      } catch (err) {
        console.error("Failed to delete batch", err);
        setAuditError("System error occurred while deleting batch.");
      }
    }
  };

  // Helper for source icon
  const getSourceIcon = (source: BatchSource) => {
    switch (source) {
        case BatchSource.ETransfer: return <Smartphone className="w-3 h-3" />;
        case BatchSource.PushPay: return <CreditCard className="w-3 h-3" />;
        default: return <Users className="w-3 h-3" />;
    }
  };

  return (
    <div className="space-y-6 h-full flex flex-col relative">
      <h2 className="text-3xl font-bold text-gray-800">Batch History & Audit</h2>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1 min-h-0">
        {/* Left: Batch List */}
        <div className="lg:col-span-4 space-y-4 overflow-y-auto max-h-[calc(100vh-12rem)] pr-2">
          {batches?.map(batch => (
            <div 
              key={batch.id} 
              onClick={() => setSelectedBatchId(batch.id || null)}
              className={`p-4 rounded-2xl cursor-pointer border transition-all ${
                selectedBatchId === batch.id 
                  ? 'bg-church-900 text-white shadow-xl scale-102 ring-2 ring-offset-2 ring-church-500' 
                  : 'bg-white hover:bg-blue-50 border-gray-200'
              }`}
            >
              <div className="flex justify-between items-center mb-2">
                <span className="font-bold">Batch #{batch.id}</span>
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
                <span>{new Date(batch.date).toLocaleDateString()}</span>
                <span className="font-mono font-bold">${batch.totalAmount.toFixed(2)}</span>
              </div>
            </div>
          ))}
          {(!batches || batches.length === 0) && <p className="text-gray-400 text-center py-10">No batches found.</p>}
        </div>

        {/* Right: Audit & Details */}
        <div className="lg:col-span-8 bg-white rounded-3xl shadow-xl border border-gray-100 flex flex-col overflow-hidden">
          {activeBatch ? (
            <div className="flex flex-col h-full">
               {/* Header */}
               <div className="p-6 border-b border-gray-100 bg-gray-50/50">
                 <div className="flex justify-between items-start mb-4">
                   <div>
                     <h3 className="text-2xl font-bold text-gray-800">Batch #{activeBatch.id}</h3>
                     <div className="flex gap-2 mb-1 mt-1">
                        <span className="flex items-center gap-1 bg-white px-2 py-0.5 rounded border border-gray-200 text-xs font-bold text-gray-600">
                           {getSourceIcon(activeBatch.source)} {activeBatch.source}
                        </span>
                     </div>
                     <div className="flex gap-4 text-sm mt-2">
                        <span className="text-gray-500">Date: <span className="font-semibold">{new Date(activeBatch.date).toLocaleDateString()}</span></span>
                        <span className="text-gray-500">Total: <span className="font-semibold text-church-900">${activeBatch.totalAmount.toFixed(2)}</span></span>
                     </div>
                   </div>
                   
                   {/* Batch Management Actions */}
                   <div className="flex items-center gap-2">
                     {activeBatch.status === BatchStatus.Open ? (
                       <>
                        <button 
                          onClick={() => setShowDeleteModal(true)}
                          className="p-3 rounded-xl bg-white border border-red-100 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                          title="Delete Batch"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                        <button 
                          onClick={() => navigate(`/batch-entry?batchId=${activeBatch.id}`)}
                          className="flex items-center gap-2 px-4 py-3 rounded-xl font-bold bg-white border border-gray-200 text-gray-700 hover:bg-gray-100 shadow-sm transition-colors"
                        >
                          <Edit className="w-4 h-4" /> Edit Batch
                        </button>
                        <button 
                          onClick={handleFinalizeClick}
                          className={`flex items-center gap-2 px-6 py-3 rounded-xl shadow-lg transition-all font-bold ${
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
                           className="p-2 rounded-xl bg-white border border-red-100 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                           title="Delete Batch"
                         >
                           <Trash2 className="w-4 h-4" />
                         </button>
                         {user?.role === UserRole.Administrator && (
                           <button 
                             onClick={() => setShowUnlockModal(true)}
                             className="flex items-center gap-2 px-4 py-2 rounded-xl font-bold bg-white border border-yellow-200 text-yellow-700 hover:bg-yellow-50 shadow-sm transition-colors"
                             title="Unlock Batch (Admin Only)"
                           >
                             <Unlock className="w-4 h-4" /> Unlock
                           </button>
                         )}
                         <div className="flex items-center gap-2 text-green-700 bg-green-100 px-4 py-2 rounded-xl font-bold border border-green-200">
                           <CheckCircle className="w-5 h-5" /> Batch Locked
                         </div>
                       </>
                     )}
                   </div>
                 </div>

                 {/* Reports Row */}
                 <div className="flex justify-end items-center gap-2 pt-4 border-t border-gray-200/50">
                    <span className="text-xs font-bold text-gray-400 uppercase mr-2 tracking-wider">Reports:</span>
                    <button 
                      onClick={() => navigate(`/reports/accounting/${activeBatch.id}`)}
                      className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 text-gray-600 font-bold rounded-lg hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 transition-colors text-sm"
                    >
                      <FileSpreadsheet className="w-4 h-4" /> Accounting
                    </button>
                    <button 
                      onClick={() => navigate(`/reports/envelope/${activeBatch.id}`)}
                      className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 text-gray-600 font-bold rounded-lg hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 transition-colors text-sm"
                    >
                      <Users className="w-4 h-4" /> Envelope
                    </button>
                    {activeBatch.status === BatchStatus.Finalized && (
                      <button 
                        onClick={() => navigate(`/reports/deposit-slip/${activeBatch.id}`)}
                        className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 text-gray-600 font-bold rounded-lg hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 transition-colors text-sm"
                      >
                        <ScrollText className="w-4 h-4" /> Deposit Slip
                      </button>
                    )}
                 </div>
               </div>

               {/* Audit Workspace */}
               <div className="flex-1 overflow-y-auto p-6 space-y-6">
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
                     {/* Cash Audit Section */}
                     <div className={`p-6 rounded-2xl border-2 transition-colors ${isCashBalanced ? 'bg-green-50/30 border-green-200' : 'bg-red-50/30 border-red-200'}`}>
                        <div className="flex justify-between items-center mb-4">
                          <h4 className="font-bold text-gray-700 flex items-center gap-2">
                            <Banknote className="w-5 h-5 text-church-500" /> Cash Audit
                          </h4>
                          <div className={`text-sm px-3 py-1 rounded-lg font-bold ${isCashBalanced ? 'text-green-700 bg-green-100' : 'text-red-600 bg-red-100'}`}>
                             {isCashBalanced 
                               ? 'Balanced' 
                               : (isCashTotalBalanced ? 'Count Mismatch' : `Variance: ${cashDiff > 0 ? '+' : ''}${cashDiff.toFixed(2)}`)
                             }
                          </div>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                          {DENOMINATIONS.map(denom => {
                            const sysCount = systemDenomCounts[denom.toString()] || 0;
                            const userCount = cashCounts[denom.toString()] || 0;
                            const match = sysCount === userCount;
                            
                            return (
                              <div key={denom} className="relative">
                                <label className="text-xs font-bold text-gray-400 block mb-1 text-center">${denom}</label>
                                <input 
                                  type="number" 
                                  min="0"
                                  disabled={activeBatch.status === BatchStatus.Finalized}
                                  className={`w-full p-2 rounded-lg border text-center outline-none focus:ring-2 focus:ring-church-500 font-bold ${match ? 'bg-white border-gray-200 text-gray-800' : 'bg-red-50 border-red-300 text-red-600'}`}
                                  value={cashCounts[denom.toString()] || ''}
                                  onChange={(e) => setCashCounts({...cashCounts, [denom.toString()]: parseInt(e.target.value) || 0})}
                                />
                                {/* Expected Count Indicator if mismatch and strictly auditing */}
                                {(!match && activeBatch.status === BatchStatus.Open) && (
                                  <div className="text-[10px] text-center text-gray-400 mt-1 font-medium">Exp: {sysCount}</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        
                        <div className="flex justify-between items-center mt-4 pt-4 border-t border-gray-200/50">
                           <div className="text-sm text-gray-500">System Recorded: <span className="font-bold">${systemCashTotal.toFixed(2)}</span></div>
                           <div className="text-lg text-gray-800">Counted: <span className="font-bold">${countedCashTotal.toFixed(2)}</span></div>
                        </div>
                     </div>

                     {/* Check Audit Section */}
                     <div className={`p-6 rounded-2xl border-2 transition-colors ${isCheckBalanced ? 'bg-green-50/30 border-green-200' : 'bg-red-50/30 border-red-200'}`}>
                        <div className="flex justify-between items-center mb-4">
                          <h4 className="font-bold text-gray-700 flex items-center gap-2">
                            <FileText className="w-5 h-5 text-church-500" /> Cheque Audit
                          </h4>
                          <div className={`text-sm px-3 py-1 rounded-lg font-bold ${isCheckBalanced ? 'text-green-700 bg-green-100' : 'text-red-600 bg-red-100'}`}>
                             {isCheckBalanced ? 'Balanced' : `Count Variance: ${checkCountDiff > 0 ? '+' : ''}${checkCountDiff}`}
                          </div>
                        </div>

                        <div className="flex items-center gap-6">
                          <div className="flex-1">
                            <label className="block text-sm font-medium text-gray-500 mb-1">Physical Cheque Count</label>
                            <input 
                               type="number" 
                               placeholder="Enter total cheques..."
                               disabled={activeBatch.status === BatchStatus.Finalized}
                               className="w-full p-3 rounded-xl border border-gray-200 text-lg font-bold bg-white focus:ring-2 focus:ring-church-500 outline-none"
                               value={userCheckCount}
                               onChange={(e) => setUserCheckCount(e.target.value)}
                            />
                          </div>
                          <div className="text-right">
                             <div className="text-sm text-gray-500">System Count</div>
                             <div className="text-2xl font-bold text-gray-800">{systemCheckCount}</div>
                          </div>
                          <div className="text-right">
                             <div className="text-sm text-gray-500">Total Value</div>
                             <div className="text-2xl font-bold text-church-900">${systemCheckTotal.toFixed(2)}</div>
                          </div>
                        </div>

                        {/* Deposit Slip / Check List */}
                        <div className="mt-6">
                           <h5 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                             <ScrollText className="w-3 h-3" /> Deposit Summary (Cheques)
                           </h5>
                           <div className="bg-white rounded-xl border border-gray-200 overflow-hidden max-h-40 overflow-y-auto">
                             <table className="w-full text-sm text-left">
                               <thead className="bg-gray-50 text-gray-500">
                                 <tr>
                                   <th className="p-2 pl-4">Cheque #</th>
                                   <th className="p-2">Giver ID</th>
                                   <th className="p-2 text-right pr-4">Amount</th>
                                 </tr>
                               </thead>
                               <tbody>
                                 {systemCheckDonations.map(d => (
                                   <tr key={d.id} className="border-b border-gray-50 last:border-0 hover:bg-blue-50">
                                     <td className="p-2 pl-4 font-mono text-gray-600">{d.chequeNumber || '-'}</td>
                                     <td className="p-2 text-gray-500">#{d.giverId}</td>
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
               <h3 className="text-xl font-bold text-gray-800 mb-2">Finalize Batch #{selectedBatchId}?</h3>
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
                   className="flex-1 py-3 bg-church-900 text-white font-bold rounded-xl hover:bg-church-800 shadow-lg transition-transform active:scale-95"
                 >
                   Confirm & Lock
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
               <h3 className="text-xl font-bold text-gray-800 mb-2">Delete Batch #{selectedBatchId}?</h3>
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
               <h3 className="text-xl font-bold text-gray-800 mb-2">Unlock Batch #{selectedBatchId}?</h3>
               <p className="text-gray-500 mb-6 text-sm">
                 This will reopen the batch for editing. Only Administrators can perform this action.
               </p>
               <div className="flex gap-3 w-full">
                 <button 
                   onClick={() => setShowUnlockModal(false)}
                   className="flex-1 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition-colors"
                 >
                   Cancel
                 </button>
                 <button 
                   onClick={executeUnlock}
                   className="flex-1 py-3 bg-yellow-600 text-white font-bold rounded-xl hover:bg-yellow-700 shadow-lg transition-transform active:scale-95"
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
