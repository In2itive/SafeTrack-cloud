import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  useLive, listGivers, getGivers, getSystemGivers, SystemGivers, listInternalAccounts, listFunds,
  getBatch, listDonations, saveBatch, deleteDonation, addGiver, getNextEnvelopeNumber,
} from '../services/repo';
import { PaymentMethod, BatchStatus, DonationSplit, Giver, Batch, BatchSource, FundEntity } from '../types';
import { Plus, Save, Trash2, AlertCircle, Layers, Calculator, X, Check, Banknote, Search, UserPlus, AlertTriangle, ChevronDown, ArrowLeft, Users, CreditCard, Smartphone } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';

// --- Types ---

interface Row {
  id: number; // React Key (timestamp or DB ID)
  donationId?: string; // DB ID if editing existing donation
  // Giver Data
  giverId?: string; 
  inputValue: string; // The text in the giver input
  // Financial Data
  amount: string;
  method: PaymentMethod;
  chequeNumber: string;
  splits: DonationSplit[];
  // Cash Data
  cashCounts: Record<string, number>;
  // UI State
  error?: string;
}

const DENOMINATIONS = [100, 50, 20, 10, 5, 2, 1, 0.25, 0.10, 0.05];
const FUND_INTERNAL = 'Internal';

// --- Helper Components ---

const GiverInput: React.FC<{
  rowId: number;
  value: string;
  isLocked: boolean;
  onChange: (val: string) => void;
  onSelect: (giver: Giver) => void;
  onCreate: (name: string) => void;
  onClear: () => void;
  givers: Giver[];
  systemGivers?: SystemGivers;
  autoFocus?: boolean;
}> = ({ rowId, value, isLocked, onChange, onSelect, onCreate, onClear, givers, systemGivers, autoFocus }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter logic
  const filtered = useMemo(() => {
    const term = value.toLowerCase();
    if (!term) return [];
    
    const results: any[] = [];

    // Special System Givers
    if (systemGivers && ('loose giving'.includes(term) || term === '0')) {
        results.push(systemGivers.loose);
    }
    if (systemGivers && ('internal'.includes(term) || term === '1')) {
        results.push(systemGivers.internal);
    }

    // Exact envelope match first
    const exactEnv = givers.filter(g => g && g.envelopeNumber && g.envelopeNumber.toString() === term);
    
    // Name, ID, or partial envelope matches
    const others = givers.filter(g => 
      g && (
       (g.name && g.name.toLowerCase().includes(term)) || 
       (g.name2 && g.name2.toLowerCase().includes(term)) ||
       (g.eTransferId && g.eTransferId.toLowerCase().includes(term)) ||
       (g.eTransferId2 && g.eTransferId2.toLowerCase().includes(term)) ||
       (g.envelopeNumber && g.envelopeNumber.toString().includes(term))
      ) 
      && g.envelopeNumber && g.envelopeNumber.toString() !== term
    ).slice(0, 5); // Limit results

    return [...results, ...exactEnv, ...others];
  }, [value, givers]);

  const showCreateOption = value.length > 1 
    && !filtered.find(g => g.name.toLowerCase() === value.toLowerCase())
    && value.toLowerCase() !== 'loose giving'
    && value.toLowerCase() !== 'internal';

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(prev => (prev + 1) % (filtered.length + (showCreateOption ? 1 : 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(prev => (prev - 1 + filtered.length + (showCreateOption ? 1 : 0)) % (filtered.length + (showCreateOption ? 1 : 0)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex < filtered.length) {
        onSelect(filtered[activeIndex]);
        setIsOpen(false);
      } else if (showCreateOption) {
        onCreate(value);
        setIsOpen(false);
      }
    } else if (e.key === 'Tab') {
      setIsOpen(false);
    }
  };

  if (isLocked) {
    return (
      <div className="relative w-full">
        <div className="absolute left-3 top-2.5 w-4 h-4 text-church-500">
           <Check className="w-4 h-4" />
        </div>
        <input
          type="text"
          readOnly
          className="w-full pl-9 pr-10 py-1.5 rounded-lg border border-green-400 bg-green-50 text-green-900 outline-none text-base font-bold cursor-default"
          value={value}
        />
        <button
          type="button"
          onClick={onClear}
          className="absolute right-2 top-1 p-1 text-gray-400 hover:text-red-500 rounded-full hover:bg-red-50 transition-colors"
          title="Clear Selection"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative w-full">
      <div className="relative">
        <Search className="absolute left-3 top-2 w-4 h-4 text-gray-400" />
        <input
          ref={inputRef}
          type="text"
          className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-gray-400 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-church-500 outline-none text-base font-medium"
          placeholder="Env #, Name, or ID"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setIsOpen(true);
            setActiveIndex(0);
          }}
          onFocus={() => setIsOpen(true)}
          onBlur={() => setTimeout(() => setIsOpen(false), 200)}
          onKeyDown={handleKeyDown}
          autoFocus={autoFocus}
        />
      </div>

      {isOpen && value && (filtered.length > 0 || showCreateOption) && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl shadow-2xl border border-gray-100 z-50 overflow-hidden">
          {filtered.map((g, idx) => (
            <div
              key={g.id}
              className={`px-4 py-2 cursor-pointer flex justify-between items-center ${idx === activeIndex ? 'bg-church-50' : 'hover:bg-gray-50'}`}
              onMouseDown={(e) => { e.preventDefault(); onSelect(g); setIsOpen(false); }}
            >
              <div className="flex flex-col">
                <span className="font-bold text-gray-800">{g.name}</span>
                {g.name2 && <span className="text-xs text-church-500 font-medium">& {g.name2}</span>}
                {/* Show matched ID if applicable */}
                {g.eTransferId && g.eTransferId.toLowerCase().includes(value.toLowerCase()) && (
                  <span className="text-xs text-gray-400">Match: {g.eTransferId}</span>
                )}
                {g.eTransferId2 && g.eTransferId2.toLowerCase().includes(value.toLowerCase()) && (
                  <span className="text-xs text-gray-400">Match: {g.eTransferId2}</span>
                )}
              </div>
              <span className="text-xs font-mono bg-gray-100 px-2 py-1 rounded text-gray-500">#{g.envelopeNumber}</span>
            </div>
          ))}
          
          {showCreateOption && (
            <div
              className={`px-4 py-3 cursor-pointer flex items-center gap-2 text-church-500 font-bold border-t border-gray-100 ${activeIndex === filtered.length ? 'bg-church-50' : 'hover:bg-gray-50'}`}
              onMouseDown={(e) => { e.preventDefault(); onCreate(value); setIsOpen(false); }}
            >
              <UserPlus className="w-4 h-4" />
              Create "{value}"
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const InternalAccountInput: React.FC<{
  value: string;
  onChange: (val: string) => void;
  accounts: { id?: string, name: string }[];
}> = ({ value, onChange, accounts }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const term = value.toLowerCase();
    if (!term) return accounts;
    return accounts.filter(a => a.name.toLowerCase().includes(term)).slice(0, 5);
  }, [value, accounts]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(prev => (prev + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(prev => (prev - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered.length > 0 && activeIndex < filtered.length) {
        onChange(filtered[activeIndex].name);
        setIsOpen(false);
      }
    } else if (e.key === 'Tab') {
      setIsOpen(false);
    }
  };

  return (
    <div className="relative w-full">
      <input
        ref={inputRef}
        type="text"
        className="w-full p-1.5 rounded-lg border border-gray-400 bg-white text-base font-bold text-gray-800 focus:ring-2 focus:ring-church-500 outline-none uppercase transition-all placeholder:font-normal placeholder:text-gray-400 placeholder:normal-case"
        placeholder="Enter account code"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setIsOpen(true);
          setActiveIndex(0);
        }}
        onFocus={() => setIsOpen(true)}
        onBlur={() => setTimeout(() => setIsOpen(false), 200)}
        onKeyDown={handleKeyDown}
      />
      {isOpen && filtered.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl shadow-2xl border border-gray-100 z-50 overflow-hidden">
          {filtered.map((a, idx) => (
            <div
              key={a.id}
              className={`px-4 py-2 cursor-pointer flex justify-between items-center ${idx === activeIndex ? 'bg-church-50' : 'hover:bg-gray-50'}`}
              onMouseDown={(e) => { e.preventDefault(); onChange(a.name); setIsOpen(false); }}
            >
              <span className="font-bold text-gray-800 uppercase">{a.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// --- Main Component ---

const BatchEntry: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const editBatchId = searchParams.get('batchId');

  const allGivers = useLive(listGivers) || [];
  const internalAccounts = (useLive(listInternalAccounts) || []).filter(a => a.isActive);
  const systemGivers = useLive(getSystemGivers);
  
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [editingBatch, setEditingBatch] = useState<Batch | null>(null);
  const [newGiverIds, setNewGiverIds] = useState<string[]>([]);
  
  const [rows, setRows] = useState<Row[]>([
    { 
      id: Date.now(), 
      inputValue: '', 
      amount: '', 
      method: PaymentMethod.Cheque,
      chequeNumber: '',
      splits: [{ fund: 'General', amount: 0 }],
      cashCounts: {} 
    }
  ]);
  
  const [isSaving, setIsSaving] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  // Modals
  const [splitRowId, setSplitRowId] = useState<number | null>(null);
  const [cashRowId, setCashRowId] = useState<number | null>(null);
  const [quickAddName, setQuickAddName] = useState<string | null>(null);
  const [alertModal, setAlertModal] = useState<{ isOpen: boolean; message: string; onConfirm?: () => void }>({ isOpen: false, message: '' });
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 100);
  };

  const showAlert = (message: string, onConfirm?: () => void) => {
    setAlertModal({ isOpen: true, message, onConfirm });
  };

  // Batch this screen created/saved itself; no need to reload it from the server
  const savedBatchIdRef = useRef<string | null>(null);

  // Load Batch Data if editing
  useEffect(() => {
    if (!editBatchId) {
      setIsLoaded(true);
      return;
    }
    if (savedBatchIdRef.current === editBatchId) {
      setIsLoaded(true);
      return;
    }

    const loadData = async () => {
      try {
        const bId = editBatchId;
        const batch = await getBatch(bId);
        if (!batch) {
          showAlert("Batch not found", () => navigate('/history'));
          return;
        }

        if (batch.status === BatchStatus.Finalized) {
          showAlert("This batch is finalized. An administrator must unlock it before it can be edited.", () => navigate('/history'));
          return;
        }

        const donations = await listDonations(bId);
        
        // Fetch givers to populate inputs
        const giverIds = [...new Set(donations.map(d => d.giverId))];
        const givers = await getGivers(giverIds);
        const giverMap = new Map<string, Giver>(givers.map(g => [g.id!, g]));

        const loadedRows: Row[] = donations.map(d => {
          const g = giverMap.get(d.giverId);

          const nameDisplay = g ? (g.name2 ? `${g.name} & ${g.name2}` : g.name) : 'Unknown';
          const envDisplay = g ? g.envelopeNumber : '0';

          return {
            id: Math.random(), // React key only
            donationId: d.id,
            giverId: d.giverId,
            inputValue: `${nameDisplay} (#${envDisplay})`,
            amount: d.amount.toString(),
            method: d.paymentMethod,
            chequeNumber: d.chequeNumber || '',
            splits: Array.isArray(d.splits) ? d.splits : [{ fund: 'General', amount: d.amount }],
            cashCounts: d.cashCounts || {}
          };
        });

        setEditingBatch(batch);
        setDate(batch.date);
        setNewGiverIds(batch.newGiverIds || []);
        setRows(loadedRows);
      } catch (e) {
        console.error("Failed to load batch", e);
      } finally {
        setIsLoaded(true);
      }
    };
    
    loadData();
  }, [editBatchId, navigate]);


  // --- Row Logic ---

  const addRow = async () => {
    const success = await handleSave(false);
    if (success) {
      setRows(prev => [
        ...prev, 
        { 
          id: Date.now(), 
          inputValue: '', 
          amount: '', 
          method: PaymentMethod.Cheque, 
          chequeNumber: '',
          splits: [{ fund: 'General', amount: 0 }],
          cashCounts: {}
        }
      ]);
      scrollToBottom();
    }
  };

  const removeRow = async (id: number) => {
    const row = rows.find(r => r.id === id);
    if (row && row.donationId) {
      // Delete straight away (totals are computed by the server, nothing else to update)
      try {
        await deleteDonation(row.donationId);
      } catch (err: any) {
        showAlert("Could not delete row: " + (err.message || 'unknown error'));
        return;
      }
    }

    if (rows.length > 1 || rows.length === 1 && editBatchId) {
       const newRows = rows.filter(r => r.id !== id);
       if (newRows.length === 0) {
         setRows([{ 
           id: Date.now(), inputValue: '', amount: '', method: PaymentMethod.Cheque, 
           chequeNumber: '', splits: [{ fund: 'General', amount: 0 }], cashCounts: {} 
         }]);
       } else {
         setRows(newRows);
       }
    } else {
      setRows(prev => {
        const newRows = prev.filter(r => r.id !== id);
        return newRows.length === 0 ? [{ 
           id: Date.now(), inputValue: '', amount: '', method: PaymentMethod.Cheque, 
           chequeNumber: '', splits: [{ fund: 'General', amount: 0 }], cashCounts: {} 
        }] : newRows;
      });
    }
  };

  const updateRow = (id: number, updates: Partial<Row>) => {
    setRows(prev => prev.map(row => {
      if (row.id === id) {
        const updated = { ...row, ...updates, error: undefined };
        if (updates.amount !== undefined) {
          const numAmount = parseFloat(updates.amount) || 0;
          if (updated.splits.length === 1) {
             updated.splits = [{ ...updated.splits[0], amount: numAmount }];
          }
        }
        return updated;
      }
      return row;
    }));
  };

  const handleGiverSelect = (rowId: number, giver: Giver) => {
    const nameDisplay = giver.name2 ? `${giver.name} & ${giver.name2}` : giver.name;
    const updates: Partial<Row> = { 
      giverId: giver.id, 
      inputValue: `${nameDisplay} (#${giver.envelopeNumber})` 
    };

    // If Internal Giver (Env 1), default split to Internal fund
    if (giver.envelopeNumber === 1) {
       updates.splits = [{ fund: FUND_INTERNAL, amount: 0 }];
    } else if (giver.envelopeNumber === 0) {
       // Optional: Reset to General for Loose Giving if needed, or keep existing
       // updates.splits = [{ fund: 'General', amount: 0 }];
    }

    updateRow(rowId, updates);
    setTimeout(() => document.getElementById(`amount-${rowId}`)?.focus(), 50);
  };

  const handleCreateGiverStart = (rowId: number, name: string) => {
    setQuickAddName(name); 
    pendingRowRef.current = rowId;
  };
  const pendingRowRef = useRef<number | null>(null);

  const handleGiverCreated = (giver: Giver) => {
    if (pendingRowRef.current) {
      handleGiverSelect(pendingRowRef.current, giver);
      pendingRowRef.current = null;
    }
    if (giver.id) {
      setNewGiverIds(prev => [...prev, giver.id as string]);
    }
    setQuickAddName(null);
  };

  // --- Save Logic ---

  const calculateTotal = () => rows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);

  const handleSave = async (navigateAway = true): Promise<boolean> => {
    const errors: string[] = [];
    rows.forEach((r, idx) => {
      const isEmpty = !r.giverId && !r.amount;
      if (isEmpty) return;

      if (!r.giverId) errors.push(`Row ${idx + 1}: No Giver selected.`);
      if (!parseFloat(r.amount)) errors.push(`Row ${idx + 1}: Amount is 0.`);
      
      const splitTotal = r.splits.reduce((sum, s) => sum + s.amount, 0);
      if (Math.abs(splitTotal - (parseFloat(r.amount) || 0)) > 0.01) {
        errors.push(`Row ${idx + 1}: Split amounts do not match total.`);
      }

      // Validate Cheque Number
      if (r.method === PaymentMethod.Cheque) {
        if (!r.chequeNumber || r.chequeNumber.trim() === '') {
          errors.push(`Row ${idx + 1}: Cheque number is required.`);
        }
      }
      
      // Validate Cash Denominations
      if (r.method === PaymentMethod.Cash) {
        const cashTotal = DENOMINATIONS.reduce((s, d) => s + (d * (r.cashCounts[d.toString()] || 0)), 0);
        if (Math.abs(cashTotal - (parseFloat(r.amount) || 0)) > 0.01) {
           errors.push(`Row ${idx + 1}: Cash denominations must be entered and match the donation amount.`);
        }
      }

      // Validate Internal Fund Account Number
      r.splits.forEach(split => {
        if (split.fund === FUND_INTERNAL && (!split.internalAccount || split.internalAccount.trim() === '')) {
          errors.push(`Row ${idx + 1}: Internal fund allocation requires an Account Number.`);
        }
      });
    });

    if (errors.length > 0) {
      showAlert("Please fix the following errors:\n" + errors.join("\n"));
      return false;
    }

    if (isSaving) return false;
    setIsSaving(true);
    try {
      let currentBatchId = editBatchId || undefined;
      const newDonationIds: Record<number, string> = {};

      // Rows that hold data, in screen order
      const kept = rows.filter(row => !(!row.giverId && !parseFloat(row.amount)));

      // One atomic server call: batch + donations + splits, or nothing.
      const result = await saveBatch({
        batchId: currentBatchId,
        date,
        source: editingBatch?.source,
        rows: kept.map(row => ({
          donationId: row.donationId,
          giverId: row.giverId!,
          amount: parseFloat(row.amount) || 0,
          method: row.method,
          chequeNumber: row.method === PaymentMethod.Cheque ? row.chequeNumber : undefined,
          splits: row.splits,
          cashCounts: row.method === PaymentMethod.Cash ? row.cashCounts : undefined,
        })),
        deletedDonationIds: [],
        newGiverIds,
      });
      currentBatchId = result.batchId;
      savedBatchIdRef.current = result.batchId;
      kept.forEach((row, i) => { if (!row.donationId) newDonationIds[row.id] = result.donationIds[i]; });
      if (!editingBatch?.batchNumber) {
        // pick up the batch number the server just assigned
        const fresh = await getBatch(result.batchId);
        if (fresh) setEditingBatch(fresh);
      }
      
      if (Object.keys(newDonationIds).length > 0) {
         setRows(prev => prev.map(r => newDonationIds[r.id] ? { ...r, donationId: newDonationIds[r.id] } : r));
      }

      if (navigateAway) {
        navigate('/history');
      } else {
        if (!editBatchId && currentBatchId) {
          navigate(`?batchId=${currentBatchId}`, { replace: true });
        }
      }
      return true;
    } catch (err: any) {
      console.error("Batch Save Error:", err);
      showAlert("Failed to save batch: " + (err.message || 'unknown error'));
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'Tab' && !e.shiftKey && index === rows.length - 1) {
      const currentRow = rows[index];
      if (currentRow.inputValue && currentRow.amount) {
        addRow();
      }
    }
  };

  // Helper for source display
  const getSourceIcon = (source: BatchSource) => {
    switch (source) {
        case BatchSource.ETransfer: return <Smartphone className="w-3 h-3" />;
        case BatchSource.PushPay:
        case BatchSource.Stripe: return <CreditCard className="w-3 h-3" />;
        default: return <Users className="w-3 h-3" />;
    }
  };

  if (!isLoaded) return <div className="p-8 text-center text-gray-500">Loading batch data...</div>;

  return (
    <div className="absolute inset-0 flex flex-col -mx-4 px-4 overflow-hidden">
      {/* Sticky Header */}
      <div className="flex justify-between items-center sticky top-0 z-40 bg-gray-100 py-3 shrink-0 mb-4 border-b border-gray-200">
        <div>
           {editBatchId ? (
             <div className="flex items-center gap-2">
                <button onClick={() => navigate('/history')} className="p-2 hover:bg-gray-200 rounded-full transition-colors">
                  <ArrowLeft className="w-5 h-5 text-gray-600" />
                </button>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-3xl font-bold text-gray-800">Edit Batch #{editingBatch?.batchNumber || '…'}</h2>
                    {editingBatch && (
                      <span className="flex items-center gap-1 bg-gray-100 text-gray-600 text-xs px-2 py-1 rounded-full font-bold border border-gray-200">
                        {getSourceIcon(editingBatch.source)} {editingBatch.source}
                      </span>
                    )}
                  </div>
                  <p className="text-gray-500 text-sm">Modify donations, add records, or delete rows.</p>
                </div>
             </div>
           ) : (
             <div>
               <div className="flex items-center gap-2">
                 <h2 className="text-3xl font-bold text-gray-800">New Batch Entry</h2>
                 <span className="flex items-center gap-1 bg-blue-100 text-church-900 text-xs px-2 py-1 rounded-full font-bold border border-blue-200">
                    <Users className="w-3 h-3" /> {BatchSource.InPerson}
                 </span>
               </div>
               <p className="text-gray-500 text-sm">Rapidly process donations with inline tools.</p>
             </div>
           )}
        </div>
        
        <div className="flex items-center gap-4">
          <div className="bg-white/80 p-1 flex items-center rounded-xl border border-gray-200 text-right shadow-sm px-4 py-2">
            <div>
              <p className="text-xs uppercase font-bold text-gray-400">Batch Total</p>
              <p className="text-2xl font-bold text-church-900">${calculateTotal().toFixed(2)}</p>
            </div>
          </div>
          <button 
            onClick={() => handleSave(true)}
            className="bg-church-gold hover:bg-yellow-400 text-church-900 px-6 py-2.5 rounded-xl font-bold flex items-center gap-2 transition-transform active:scale-95 shadow-md"
          >
            <Save className="w-5 h-5" /> {editBatchId ? 'Update & Exit' : 'Save & Exit'}
          </button>
        </div>
      </div>

      {/* Grid Container */}
      <div className="bg-white p-4 rounded-3xl shadow-xl flex-1 flex flex-col overflow-hidden border border-gray-100 mb-4 min-h-0">
        <div className="flex gap-4 mb-4 items-center border-b border-gray-100 pb-4">
          <label className="font-bold text-gray-700">Batch Date:</label>
          <input 
            type="date" 
            value={date} 
            onChange={(e) => setDate(e.target.value)}
            className="border-gray-400 border rounded-lg p-2 bg-gray-50 text-gray-800"
          />
        </div>

        <div className="flex-1 overflow-visible overflow-y-auto min-h-0 pb-4">
          <table className="w-full text-left border-collapse">
            <thead className="bg-gray-50 sticky top-0 z-40 text-gray-600">
              <tr>
                <th className="py-2 px-2 text-base font-bold rounded-tl-xl w-1/3">Giver Lookup</th>
                <th className="py-2 px-2 text-base font-bold w-32">Amount</th>
                <th className="py-2 px-2 text-base font-bold w-48">Method</th>
                <th className="py-2 px-2 text-base font-bold">Allocations</th>
                <th className="py-2 px-2 text-base font-bold rounded-tr-xl w-16"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const isUnbalanced = Math.abs(row.splits.reduce((s, x) => s + x.amount, 0) - (parseFloat(row.amount) || 0)) > 0.01;
                const cashTotal = DENOMINATIONS.reduce((s, d) => s + (d * (row.cashCounts[d.toString()] || 0)), 0);
                const cashMismatch = row.method === PaymentMethod.Cash && cashTotal > 0 && Math.abs(cashTotal - (parseFloat(row.amount) || 0)) > 0.01;

                return (
                  <tr key={row.id} className="border-b border-gray-50 last:border-0 hover:bg-blue-50/30 transition-colors group align-top">
                    {/* Giver Search Column */}
                    <td className="p-1 relative z-10">
                      <GiverInput 
                        rowId={row.id}
                        value={row.inputValue}
                        isLocked={row.giverId !== undefined}
                        onChange={(val) => updateRow(row.id, { inputValue: val, giverId: undefined })}
                        onSelect={(g) => handleGiverSelect(row.id, g)}
                        onCreate={(name) => handleCreateGiverStart(row.id, name)}
                        onClear={() => updateRow(row.id, { giverId: undefined, inputValue: '' })}
                        givers={allGivers}
                        systemGivers={systemGivers}
                        autoFocus={index === rows.length - 1 && index > 0}
                      />
                    </td>
                    
                    {/* Amount Column */}
                    <td className="p-1">
                      <div className="relative">
                        <span className="absolute left-3 top-1.5 text-gray-400 font-bold">$</span>
                        <input 
                          id={`amount-${row.id}`}
                          type="number"
                          step="0.01"
                          className={`w-full pl-6 p-1.5 rounded-lg border text-base font-bold outline-none focus:ring-2 focus:ring-church-500 ${isUnbalanced ? 'border-red-300 bg-red-50 text-red-600' : 'border-gray-400 bg-gray-50 text-gray-800'}`}
                          value={row.amount}
                          onChange={(e) => updateRow(row.id, { amount: e.target.value })}
                          placeholder="0.00"
                        />
                      </div>
                    </td>

                    {/* Method Column */}
                    <td className="p-1">
                       <div className="flex gap-2">
                        <select 
                          className={`p-1.5 rounded-lg border border-gray-400 bg-gray-50 text-base outline-none focus:ring-2 focus:ring-church-500 transition-all ${row.method === PaymentMethod.Cheque ? 'w-1/2' : 'flex-1'}`}
                          value={row.method}
                          onChange={(e) => updateRow(row.id, { method: e.target.value as PaymentMethod })}
                        >
                          {Object.values(PaymentMethod).map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                        
                        {/* Cheque Number Input */}
                        {row.method === PaymentMethod.Cheque && (
                          <input 
                            type="text" 
                            placeholder="Chq #" 
                            className="w-1/2 p-1.5 rounded-lg border border-gray-400 bg-gray-50 text-base outline-none focus:ring-2 focus:ring-church-500"
                            value={row.chequeNumber}
                            onChange={(e) => updateRow(row.id, { chequeNumber: e.target.value })}
                          />
                        )}

                        {/* Cash Details Button */}
                        {row.method === PaymentMethod.Cash && (
                          <button 
                            onClick={() => setCashRowId(row.id)}
                            className={`p-1.5 px-2 rounded-lg transition-colors border ${cashMismatch ? 'bg-red-100 text-red-500 border-red-400' : 'bg-gray-100 text-gray-400 hover:bg-church-100 hover:text-church-500 border-gray-400'}`}
                            title="Cash Denominations"
                            tabIndex={-1}
                          >
                            <Banknote className="w-4 h-4" />
                          </button>
                        )}
                       </div>
                    </td>

                    {/* Allocations (Split) Column */}
                    <td className="p-1">
                      <button 
                        onClick={() => setSplitRowId(row.id)}
                        onKeyDown={(e) => handleKeyDown(e, index)}
                        className={`w-full text-left px-2 py-1.5 rounded-lg text-base font-medium border transition-all flex items-center justify-between outline-none focus:ring-2 focus:ring-church-500 ${
                          isUnbalanced 
                            ? 'bg-red-50 border-red-400 text-red-700' 
                            : 'bg-white border-gray-400 text-gray-600 hover:border-church-500'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Layers className="w-4 h-4 opacity-50" />
                          <span className="truncate">
                            {row.splits.length === 1 
                              ? (row.splits[0].fund === FUND_INTERNAL 
                                  ? `Internal ${row.splits[0].internalAccount ? `(${row.splits[0].internalAccount})` : ''}` 
                                  : row.splits[0].fund)
                              : `${row.splits.length} Splits`}
                          </span>
                        </div>
                        {isUnbalanced ? <AlertCircle className="w-4 h-4" /> : <ChevronDown className="w-3 h-3 opacity-30"/>}
                      </button>
                    </td>

                    {/* Delete Action */}
                    <td className="p-1 text-center">
                      <button 
                        onClick={() => removeRow(row.id)}
                        className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                        tabIndex={-1}
                        title="Delete Donation"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          
          {/* Add Row Button (Bottom) */}
          <button 
            onClick={addRow}
            className="w-full mt-2 py-3 border-2 border-dashed border-gray-400 rounded-xl text-gray-400 font-bold hover:border-church-500 hover:text-church-500 transition-all flex justify-center items-center gap-2"
          >
            <Plus className="w-5 h-5" /> Add New Row (Auto-Saves Batch)
          </button>
          <div ref={bottomRef} className="h-4" />
        </div>

      </div>

      {/* --- Modals --- */}
      
      {quickAddName && (
        <QuickAddGiverModal 
          name={quickAddName} 
          onClose={() => setQuickAddName(null)} 
          onSave={handleGiverCreated} 
        />
      )}

      {splitRowId && (
        <ErrorBoundary fallback={
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
            <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl text-center">
              <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" />
              <h3 className="text-xl font-bold text-gray-800 mb-2">Component Error</h3>
              <p className="text-gray-600 mb-6">An error occurred in the Split Modal. Please try again.</p>
              <button 
                onClick={() => setSplitRowId(null)} 
                className="bg-gray-200 text-gray-800 px-6 py-2 rounded-xl font-bold hover:bg-gray-300 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        }>
          <SplitModal 
            row={rows.find(r => r.id === splitRowId)!} 
            internalAccounts={internalAccounts}
            onClose={() => setSplitRowId(null)}
            onSave={(splits) => {
               updateRow(splitRowId, { splits });
               setSplitRowId(null);
            }}
          />
        </ErrorBoundary>
      )}

      {cashRowId && (
        <CashModal 
          row={rows.find(r => r.id === cashRowId)!}
          onClose={() => setCashRowId(null)}
          onSave={(counts) => {
            updateRow(cashRowId, { cashCounts: counts });
            setCashRowId(null);
          }}
        />
      )}

      {alertModal.isOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl animate-fade-in-up">
            <h3 className="text-xl font-bold text-gray-800 mb-4">Notice</h3>
            <p className="text-gray-600 mb-8 whitespace-pre-wrap">{alertModal.message}</p>
            <button 
              onClick={() => {
                setAlertModal(prev => ({ ...prev, isOpen: false }));
                if (alertModal.onConfirm) alertModal.onConfirm();
              }}
              className="w-full py-3 bg-church-900 text-white font-bold rounded-xl hover:bg-church-800 transition-colors shadow-lg"
            >
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// --- Sub-Modals ---

const QuickAddGiverModal: React.FC<{ name: string, onClose: () => void, onSave: (g: Giver) => void }> = ({ name, onClose, onSave }) => {
  const [nextEnv, setNextEnv] = useState<number>(0);
  const [address, setAddress] = useState<string>('');
  const [error, setError] = useState('');
  
  useEffect(() => {
    getNextEnvelopeNumber().then(setNextEnv).catch(err => console.error("Failed to get next envelope:", err));
  }, []);

  const handleConfirm = async () => {
    try {
      // The server assigns the envelope number atomically; show what it actually gave.
      const giver = await addGiver({ name, address1: address || undefined } as Giver);
      onSave(giver);
    } catch (err: any) {
      console.error("Failed to create giver:", err);
      setError(err.message || 'Could not create giver');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-center justify-center p-2">
      <div className="bg-white rounded-3xl p-4 w-full max-w-sm shadow-2xl animate-fade-in-up">
        <h3 className="text-xl font-bold mb-4 text-gray-800">Quick Register Giver</h3>
        <div className="bg-blue-50 p-4 rounded-xl mb-4 text-center">
          <p className="text-xs font-bold text-church-900 uppercase">New Giver</p>
          <p className="text-xl font-bold text-gray-800">{name}</p>
          <p className="text-sm text-church-500 font-bold mt-1">Assigning Envelope #{nextEnv}</p>
        </div>
        {error && <div className="bg-red-50 text-red-600 p-2 rounded-lg text-sm mb-4">{error}</div>}
        
        <div className="mb-4">
          <label className="block text-sm font-bold text-gray-700 mb-1">Address (Optional)</label>
          <input 
            type="text" 
            placeholder="Enter address from cheque..." 
            className="w-full p-3 rounded-xl border border-gray-400 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-church-500 outline-none text-sm"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>

        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2 text-gray-500 font-bold hover:bg-gray-100 rounded-xl">Cancel</button>
          <button onClick={handleConfirm} className="flex-1 py-2 bg-church-900 text-white font-bold rounded-xl hover:bg-blue-800">Confirm & Use</button>
        </div>
      </div>
    </div>
  );
};

// --- Error Boundary ---

class ErrorBoundary extends React.Component<{ children: React.ReactNode, fallback: React.ReactNode }, { hasError: boolean, error: any }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }

    return this.props.children;
  }
}

const SplitModal: React.FC<{ row: Row, internalAccounts: { id?: string, name: string }[], onClose: () => void, onSave: (s: DonationSplit[]) => void }> = ({ row, internalAccounts, onClose, onSave }) => {
  // Safety check: ensure row and splits exist
  const initialSplits = row && Array.isArray(row.splits) ? row.splits : [{ fund: 'General', amount: 0 }];
  
  // Use local state with string amount to allow decimal typing
  // Safety: Ensure s.amount is not null/undefined before toString()
  const [splits, setSplits] = useState<(Omit<DonationSplit, 'amount'> & { amount: string | number })[]>(
    initialSplits.map(s => ({ ...s, amount: (s.amount ?? 0).toString() }))
  );
  
  if (!row) return null;

  const totalAmount = parseFloat(row.amount) || 0;
  
  // Fetch active funds
  const funds = (useLive(listFunds) || []).filter(f => f.isActive);
  
  // Recalculate remaining logic
  const currentAllocated = splits.reduce((sum, s) => {
      const val = parseFloat(s.amount?.toString() || '0');
      return sum + (isNaN(val) ? 0 : val);
  }, 0);
  const remaining = totalAmount - currentAllocated;
  const isBalanced = Math.abs(remaining) < 0.01;

  const updateSplit = (idx: number, field: keyof DonationSplit, val: any) => {
    const newSplits = [...splits];
    if (field === 'fund') {
         // Reset internal account if switching away from Internal
         if (val !== FUND_INTERNAL) {
             delete (newSplits[idx] as any).internalAccount;
         }
    }
    // Check if index exists to be safe
    if (newSplits[idx]) {
        newSplits[idx] = { ...newSplits[idx], [field]: val };
        setSplits(newSplits);
    }
  };

  const handleSave = () => {
    const finalSplits: DonationSplit[] = splits.map(s => ({
        ...s,
        amount: parseFloat(s.amount.toString()) || 0
    }));
    onSave(finalSplits);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden animate-fade-in-up">
        <div className="bg-church-900 p-3 flex justify-between items-center text-white">
          <h3 className="font-bold text-lg flex items-center gap-2"><Layers className="w-5 h-5 text-church-gold" /> Designations</h3>
          <button onClick={onClose}><X className="w-6 h-6" /></button>
        </div>
        <div className="p-4">
          <div className="flex justify-between items-end mb-4 border-b pb-2">
            <div><p className="text-sm text-gray-500">Total Donation</p><p className="text-2xl font-bold text-gray-800">${totalAmount.toFixed(2)}</p></div>
            <div className={`text-right ${isBalanced ? 'text-green-600' : 'text-red-500'}`}>
              <p className="text-xs font-bold uppercase">Remaining</p><p className="text-xl font-bold">${remaining.toFixed(2)}</p>
            </div>
          </div>
          <div className="space-y-3 mb-4">
            {splits.map((split, idx) => (
              <div key={idx} className={`rounded-xl p-3 border transition-colors ${split.fund === FUND_INTERNAL ? 'bg-blue-50/50 border-blue-200' : 'bg-gray-50 border-gray-100'}`}>
                <div className="flex gap-2 items-center">
                  <select className="flex-1 p-2 rounded-xl border border-gray-400 bg-white text-sm focus:ring-2 focus:ring-church-500 outline-none" value={split.fund} onChange={(e) => updateSplit(idx, 'fund', e.target.value)}>
                    {funds.map(f => <option key={f.id} value={f.name}>{f.name}</option>)}
                    {/* Fallback if current split has an inactive fund not in list */}
                    {!funds.find(f => f.name === split.fund) && <option value={split.fund}>{split.fund}</option>}
                  </select>
                  <div className="relative w-32">
                    <span className="absolute left-3 top-2 text-gray-400">$</span>
                    <input 
                        type="number" 
                        step="0.01" 
                        className="w-full pl-6 p-2 rounded-xl border border-gray-400 bg-white font-bold focus:ring-2 focus:ring-church-500 outline-none" 
                        value={split.amount} 
                        onChange={(e) => updateSplit(idx, 'amount', e.target.value)} 
                    />
                  </div>
                  <button onClick={() => setSplits(splits.filter((_, i) => i !== idx))} className="p-2 text-red-400 hover:bg-red-50 rounded-lg"><Trash2 className="w-4 h-4" /></button>
                </div>
                 {split.fund === FUND_INTERNAL && (
                    <div className="mt-2 animate-fade-in">
                        <label className="text-xs font-bold text-gray-500 ml-1 mb-1 block">Internal Account Code</label>
                        <InternalAccountInput 
                            value={split.internalAccount || ''}
                            onChange={(val) => updateSplit(idx, 'internalAccount', val)}
                            accounts={internalAccounts}
                        />
                    </div>
                 )}
              </div>
            ))}
          </div>
          <button onClick={() => setSplits([...splits, { fund: 'General', amount: '' }])} className="w-full py-2 border-2 border-dashed border-gray-500 rounded-xl text-gray-400 font-bold hover:border-church-500 hover:text-church-500 transition-colors mb-6">+ Add Fund</button>
          <button disabled={!isBalanced} onClick={handleSave} className={`w-full py-3 rounded-xl font-bold flex items-center justify-center gap-2 ${isBalanced ? 'bg-church-900 text-white' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}><Check className="w-5 h-5" /> Confirm</button>
        </div>
      </div>
    </div>
  );
};

const CashModal: React.FC<{ row: Row, onClose: () => void, onSave: (c: Record<string, number>) => void }> = ({ row, onClose, onSave }) => {
  if (!row) return null;
  const [counts, setCounts] = useState<Record<string, number>>({ ...row.cashCounts });
  const total = DENOMINATIONS.reduce((sum, d) => sum + (d * (counts[d.toString()] || 0)), 0);
  const target = parseFloat(row.amount) || 0;
  const diff = total - target;
  const isMatch = Math.abs(diff) < 0.01;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl w-full max-w-2xl shadow-2xl overflow-hidden animate-fade-in-up flex flex-col max-h-[90vh]">
        <div className="bg-green-600 p-4 flex justify-between items-center text-white">
          <h3 className="font-bold text-lg flex items-center gap-2"><Calculator className="w-5 h-5 text-white" /> Cash Counter</h3>
          <button onClick={onClose}><X className="w-6 h-6" /></button>
        </div>
        <div className="p-4 overflow-y-auto flex-1">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
             {DENOMINATIONS.map(denom => (
               <div key={denom} className="bg-gray-50 p-3 rounded-xl border border-gray-100 text-center">
                 <label className="text-xs font-bold text-gray-400 block mb-1">${denom}</label>
                 <input type="number" min="0" className="w-full p-1 bg-white border border-gray-400 rounded-lg text-center font-bold text-lg focus:ring-2 focus:ring-green-500 outline-none" 
                   value={counts[denom] || ''} onChange={(e) => setCounts({...counts, [denom]: parseInt(e.target.value) || 0})} autoFocus={denom === 100} />
               </div>
             ))}
          </div>
          <div className="bg-gray-50 p-4 rounded-xl flex flex-col md:flex-row justify-between items-center gap-2">
             <div><p className="text-sm text-gray-500 font-medium">Slip Amount</p><p className="text-2xl font-bold text-gray-800">${target.toFixed(2)}</p></div>
             <div className="hidden md:block text-gray-300 text-4xl font-light">/</div>
             <div className="text-center"><p className="text-sm text-gray-500 font-medium">Cash Counted</p><p className="text-2xl font-bold text-church-900">${total.toFixed(2)}</p></div>
             <div className="hidden md:block text-gray-300 text-4xl font-light">=</div>
             <div className={`px-6 py-2 rounded-xl text-center ${isMatch ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}><p className="text-xs font-bold uppercase">Difference</p><p className="text-2xl font-bold">{diff > 0 ? '+' : ''}{diff.toFixed(2)}</p></div>
          </div>
        </div>
        <div className="p-4 border-t bg-gray-50 flex justify-end gap-3">
           <button onClick={onClose} className="px-6 py-3 font-semibold text-gray-500 hover:bg-gray-200 rounded-xl">Cancel</button>
           <button onClick={() => onSave(counts)} className="px-8 py-3 font-bold rounded-xl flex items-center gap-2 bg-green-600 text-white hover:bg-green-700 shadow-lg"><Check className="w-5 h-5" /> Save Counts</button>
        </div>
      </div>
    </div>
  );
};

export default BatchEntry;