import React, { useState } from 'react';
import {
  useLive, getSettings, updateSettings as saveSettings, listFunds, addFund, setFundActive,
  listInternalAccounts, addInternalAccount, setInternalAccountActive, listGivers, importGiversCSV,
  exportBackup, importLegacyBackup, getSmtpSettings, setSmtpSettings,
} from '../services/repo';
import { giversToCSV } from '../services/csv';
import { useAuth } from '../contexts/AuthContext';
import { UserRole } from '../types';
import { Download, Upload, RefreshCw, AlertTriangle, Layers, Plus, Trash2, CheckCircle, XCircle, Users, FileText, Mail, Landmark, Image as ImageIcon } from 'lucide-react';

const Settings: React.FC = () => {
  const [backupUrl, setBackupUrl] = useState<string | null>(null);
  const [newFundName, setNewFundName] = useState('');
  const [newInternalAccountName, setNewInternalAccountName] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [modal, setModal] = useState<{
    isOpen: boolean;
    type: 'confirm' | 'alert';
    message: string;
    onConfirm?: () => void;
    onCancel?: () => void;
  }>({ isOpen: false, type: 'alert', message: '' });
  
  const { user } = useAuth();
  const isAdmin = user?.role === UserRole.Administrator;
  const settings = useLive(getSettings);
  const funds = useLive(listFunds);
  const internalAccounts = useLive(listInternalAccounts);
  const smtp = useLive(() => isAdmin ? getSmtpSettings() : Promise.resolve(null), [isAdmin]);

  // Text fields edit a local draft and save when the field loses focus, so
  // typing doesn't send a network write (and an audit entry) per keystroke.
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [draftLoaded, setDraftLoaded] = useState(false);
  React.useEffect(() => {
    if (settings && smtp !== undefined && !draftLoaded) {
      setDraft({
        ...settings,
        smtpHost: smtp?.host ?? '', smtpPort: smtp?.port ?? '', smtpUser: smtp?.username ?? '',
        smtpFrom: smtp?.fromAddress ?? '', smtpPassword: '',
      });
      setDraftLoaded(true);
    }
  }, [settings, smtp, draftLoaded]);
  const setField = (k: string, v: any) => setDraft(d => ({ ...d, [k]: v }));
  const SMTP_FIELDS = ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPassword', 'smtpFrom'];

  const commitSmtp = async () => {
    const { smtpHost, smtpPort, smtpUser, smtpPassword, smtpFrom } = draft;
    if (!smtpHost || !smtpPort || !smtpUser || !smtpFrom) return; // save once the required fields are filled
    if (!smtpPassword && !smtp?.hasPassword) return;
    try {
      await setSmtpSettings({ host: smtpHost, port: Number(smtpPort), username: smtpUser, fromAddress: smtpFrom, password: smtpPassword || undefined });
      setField('smtpPassword', '');
    } catch (err: any) {
      showAlert('Failed to save email settings: ' + err.message);
    }
  };

  const commitField = async (k: string) => {
    if (SMTP_FIELDS.includes(k)) return commitSmtp();
    if (!settings) return;
    const v = draft[k];
    if (k === 'nextEnvelopeNumber') {
      const num = parseInt(v);
      if (!isNaN(num) && num !== settings.nextEnvelopeNumber) await updateSettings({ nextEnvelopeNumber: num });
      return;
    }
    if ((v ?? '') !== ((settings as any)[k] ?? '')) await updateSettings({ [k]: v });
  };
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const showConfirm = (message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      setModal({
        isOpen: true,
        type: 'confirm',
        message,
        onConfirm: () => {
          setModal(prev => ({ ...prev, isOpen: false }));
          resolve(true);
        },
        onCancel: () => {
          setModal(prev => ({ ...prev, isOpen: false }));
          resolve(false);
        }
      });
    });
  };

  const showAlert = (message: string) => {
    setModal({
      isOpen: true,
      type: 'alert',
      message,
      onConfirm: () => setModal(prev => ({ ...prev, isOpen: false }))
    });
  };

  const handleBackup = async () => {
    const json = await exportBackup();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    setBackupUrl(url);
  };

  const handleRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const confirmed = await showConfirm("Import this backup from the original (browser-only) SafeTrack into this church? This only works for a church with no batches yet. User accounts are not imported; invite them under User Management.");
    if(!confirmed) { e.target.value = ''; return; }

    const reader = new FileReader();
    reader.onload = async (event) => {
      const json = event.target?.result as string;
      try {
        const r = await importLegacyBackup(json);
        const notes = [
          r.renumbered_duplicate_envelopes ? `${r.renumbered_duplicate_envelopes} duplicate envelope #s were given new numbers` : '',
          r.fixed_missing_cheque_numbers ? `${r.fixed_missing_cheque_numbers} cheques had no number (marked UNKNOWN)` : '',
          r.skipped_donations_unknown_giver ? `${r.skipped_donations_unknown_giver} donations skipped (giver missing from backup)` : '',
          r.users_not_imported ? `${r.users_not_imported} user accounts need to be re-created` : '',
        ].filter(Boolean);
        showAlert(`Imported ${r.givers} givers, ${r.batches} batches (${r.finalized_batches} finalized) and ${r.donations} donations.` +
                  (notes.length ? `\n\nPlease review:\n• ${notes.join('\n• ')}` : ''));
        setDraftLoaded(false);
      } catch (err: any) {
        console.error("Restore error:", err);
        showAlert("Import failed: " + (err.message || 'invalid file'));
      } finally {
        e.target.value = '';
      }
    };
    reader.readAsText(file);
  };

  const handleExportGivers = async () => {
    const csv = giversToCSV(await listGivers());
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `givers_export_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    try {
      console.log("File change event triggered");
      const file = e.target.files?.[0];
      
      if (!file) {
        console.log("No file selected");
        return;
      }

      console.log("File selected:", file.name, file.size, file.type);

      const confirmed = await showConfirm(`Ready to import ${file.name}? Givers are matched by envelope number: existing ones are updated, new ones added. Nobody is deleted. Proceed?`);
      
      if (!confirmed) {
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }

      console.log("Starting import process...");
      setIsImporting(true);
      const reader = new FileReader();
      
      reader.onload = async (event) => {
        console.log("File read complete");
        const csv = event.target?.result as string;
        try {
          console.log("Parsing CSV...");
          const { added, updated } = await importGiversCSV(csv);
          showAlert(`Giver Registry imported: ${added} added, ${updated} updated.`);
        } catch (err: any) {
          console.error("Import error object:", err);
          let errorMessage = "Unknown error";
          if (err instanceof Error) {
            errorMessage = err.message;
          } else if (typeof err === 'object' && err !== null) {
            try {
              errorMessage = JSON.stringify(err);
            } catch (e) {
              errorMessage = String(err);
            }
          } else {
            errorMessage = String(err);
          }
          showAlert("Error importing givers: " + errorMessage);
        } finally {
          setIsImporting(false);
          if (fileInputRef.current) fileInputRef.current.value = '';
        }
      };
      
      reader.onerror = () => {
        console.error("FileReader error:", reader.error);
        showAlert("Error reading file: " + (reader.error?.message || "Unknown read error"));
        setIsImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      };

      console.log("Reading file as text...");
      reader.readAsText(file);
    } catch (err) {
      console.error("Unexpected error in handleFileChange:", err);
      showAlert("An unexpected error occurred.");
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const updateSettings = async (updates: Record<string, any>) => {
    try {
      await saveSettings(updates);
    } catch (err: any) {
      console.error("Failed to update settings:", err);
      showAlert("Failed to update settings: " + err.message);
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>, field: 'bankLogo' | 'churchLogo') => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64 = event.target?.result as string;
      setField(field, base64);
      await updateSettings({ [field]: base64 });
    };
    reader.readAsDataURL(file);
  };

  const handleAddFund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFundName.trim()) return;
    
    // Check duplicates
    const exists = funds?.some(f => f.name.toLowerCase() === newFundName.trim().toLowerCase());
    if (exists) {
      showAlert("Fund name already exists.");
      return;
    }

    try {
      await addFund(newFundName.trim());
      setNewFundName('');
    } catch (err) {
      console.error("Failed to add fund:", err);
      showAlert("Failed to add fund.");
    }
  };

  const toggleFundStatus = async (id: string, currentStatus: boolean) => {
    try {
      await setFundActive(id, !currentStatus);
    } catch (err) {
      console.error("Failed to toggle fund status:", err);
      showAlert("Failed to update fund status.");
    }
  };

  const handleAddInternalAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newInternalAccountName.trim()) return;
    
    // Check duplicates
    const exists = internalAccounts?.some(a => a.name.toLowerCase() === newInternalAccountName.trim().toLowerCase());
    if (exists) {
      showAlert("Internal account name already exists.");
      return;
    }

    try {
      await addInternalAccount(newInternalAccountName.trim());
      setNewInternalAccountName('');
    } catch (err) {
      console.error("Failed to add internal account:", err);
      showAlert("Failed to add internal account.");
    }
  };

  const toggleInternalAccountStatus = async (id: string, currentStatus: boolean) => {
    try {
      await setInternalAccountActive(id, !currentStatus);
    } catch (err) {
      console.error("Failed to toggle internal account status:", err);
      showAlert("Failed to update internal account status.");
    }
  };

  return (
    <div className="space-y-8 max-w-4xl mx-auto pb-10">
      <h2 className="text-3xl font-bold text-gray-800">Admin Settings</h2>

      {/* System Config */}
      <div className="bg-white p-8 rounded-3xl shadow-xl border border-gray-100">
        <h3 className="text-xl font-bold text-gray-800 mb-6 flex items-center gap-2">
          <RefreshCw className="w-5 h-5 text-church-500" /> System Configuration
        </h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Next Auto-Increment Envelope #</label>
            <input 
              type="number" 
              className="w-full p-4 rounded-xl border border-gray-400 text-2xl font-bold text-church-900 focus:ring-2 focus:ring-church-500 bg-gray-50"
              value={draft.nextEnvelopeNumber ?? ''}
              onChange={(e) => setField('nextEnvelopeNumber', e.target.value)}
              onBlur={() => commitField('nextEnvelopeNumber')}
            />
            <p className="text-xs text-gray-400 mt-2">Will be used for the next new giver registration.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Counting Controls</label>
            <label className="flex items-start gap-3 p-4 rounded-xl border border-gray-300 bg-gray-50 cursor-pointer">
              <input
                type="checkbox"
                className="mt-1 w-5 h-5"
                disabled={!isAdmin}
                checked={!(settings?.allowAdminSoloFinalize ?? true)}
                onChange={(e) => updateSettings({ allowAdminSoloFinalize: !e.target.checked })}
              />
              <span className="text-sm text-gray-700">
                <strong>Strict two-person control.</strong> Administrators also need a second person
                to sign off before a batch can be finalized. Enforced by the server.
              </span>
            </label>
          </div>
        </div>
      </div>

      {/* Banking & Organization Details */}
      <div className="bg-white p-8 rounded-3xl shadow-xl border border-gray-100">
        <h3 className="text-xl font-bold text-gray-800 mb-6 flex items-center gap-2">
          <Landmark className="w-5 h-5 text-church-500" /> Banking & Organization Details
        </h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          {/* Bank Info */}
          <div className="space-y-6">
            <h4 className="font-bold text-gray-800 border-b pb-2">Bank Details</h4>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Bank Logo (250x150px recommended)</label>
              <div className="flex items-center gap-4">
                {settings?.bankLogo ? (
                  <div className="relative w-32 h-20 border rounded-lg overflow-hidden bg-gray-50 flex items-center justify-center">
                    <img src={settings.bankLogo} alt="Bank Logo" className="max-w-full max-h-full object-contain" />
                    <button 
                      onClick={() => { setField('bankLogo', ''); updateSettings({ bankLogo: '' }); }}
                      className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 hover:bg-red-600"
                      title="Remove Logo"
                    >
                      <XCircle className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="w-32 h-20 border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center text-gray-400 bg-gray-50">
                    <ImageIcon className="w-6 h-6 mb-1" />
                    <span className="text-[10px]">No Image</span>
                  </div>
                )}
                <label className="bg-white border border-gray-500 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 cursor-pointer transition-colors">
                  Upload Logo
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => handleImageUpload(e, 'bankLogo')} />
                </label>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Account Of</label>
              <input 
                type="text" 
                className="w-full p-3 rounded-xl border border-gray-400 bg-gray-50 focus:ring-2 focus:ring-church-500"
                value={draft.accountOf ?? ''}
                onChange={(e) => setField('accountOf', e.target.value)}
                onBlur={() => commitField('accountOf')}
                placeholder="First Church of Example"
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Branch #</label>
                <input 
                  type="text" 
                  className="w-full p-3 rounded-xl border border-gray-400 bg-gray-50 focus:ring-2 focus:ring-church-500"
                  value={draft.branchNumber ?? ''}
                  onChange={(e) => setField('branchNumber', e.target.value)}
                  onBlur={() => commitField('branchNumber')}
                  placeholder="12345"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Account #</label>
                <input 
                  type="text" 
                  className="w-full p-3 rounded-xl border border-gray-400 bg-gray-50 focus:ring-2 focus:ring-church-500"
                  value={draft.accountNumber ?? ''}
                  onChange={(e) => setField('accountNumber', e.target.value)}
                  onBlur={() => commitField('accountNumber')}
                  placeholder="000-1234567"
                />
              </div>
            </div>
          </div>

          {/* Church Info */}
          <div className="space-y-6">
            <h4 className="font-bold text-gray-800 border-b pb-2">Organization Details</h4>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Church Logo (250x150px recommended)</label>
              <div className="flex items-center gap-4">
                {settings?.churchLogo ? (
                  <div className="relative w-32 h-20 border rounded-lg overflow-hidden bg-gray-50 flex items-center justify-center">
                    <img src={settings.churchLogo} alt="Church Logo" className="max-w-full max-h-full object-contain" />
                    <button 
                      onClick={() => { setField('churchLogo', ''); updateSettings({ churchLogo: '' }); }}
                      className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 hover:bg-red-600"
                      title="Remove Logo"
                    >
                      <XCircle className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="w-32 h-20 border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center text-gray-400 bg-gray-50">
                    <ImageIcon className="w-6 h-6 mb-1" />
                    <span className="text-[10px]">No Image</span>
                  </div>
                )}
                <label className="bg-white border border-gray-500 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 cursor-pointer transition-colors">
                  Upload Logo
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => handleImageUpload(e, 'churchLogo')} />
                </label>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Address Line 1</label>
              <input 
                type="text" 
                className="w-full p-3 rounded-xl border border-gray-400 bg-gray-50 focus:ring-2 focus:ring-church-500"
                value={draft.churchAddressLine1 ?? ''}
                onChange={(e) => setField('churchAddressLine1', e.target.value)}
                onBlur={() => commitField('churchAddressLine1')}
                placeholder="123 Main St"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Address Line 2</label>
              <input 
                type="text" 
                className="w-full p-3 rounded-xl border border-gray-400 bg-gray-50 focus:ring-2 focus:ring-church-500"
                value={draft.churchAddressLine2 ?? ''}
                onChange={(e) => setField('churchAddressLine2', e.target.value)}
                onBlur={() => commitField('churchAddressLine2')}
                placeholder="Suite 100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Address Line 3</label>
              <input 
                type="text" 
                className="w-full p-3 rounded-xl border border-gray-400 bg-gray-50 focus:ring-2 focus:ring-church-500"
                value={draft.churchAddressLine3 ?? ''}
                onChange={(e) => setField('churchAddressLine3', e.target.value)}
                onBlur={() => commitField('churchAddressLine3')}
                placeholder="City, State, ZIP"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Email & SMTP Configuration */}
      <div className="bg-white p-8 rounded-3xl shadow-xl border border-gray-100">
        <h3 className="text-xl font-bold text-gray-800 mb-6 flex items-center gap-2">
          <Mail className="w-5 h-5 text-church-500" /> Email & SMTP Configuration
        </h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">SMTP Host</label>
            <input 
              type="text" 
              className="w-full p-3 rounded-xl border border-gray-400 bg-gray-50 focus:ring-2 focus:ring-church-500"
              value={draft.smtpHost ?? ''}
              onChange={(e) => setField('smtpHost', e.target.value)}
              onBlur={() => commitField('smtpHost')}
              placeholder="smtp.example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">SMTP Port</label>
            <input 
              type="number" 
              className="w-full p-3 rounded-xl border border-gray-400 bg-gray-50 focus:ring-2 focus:ring-church-500"
              value={draft.smtpPort ?? ''}
              onChange={(e) => setField('smtpPort', e.target.value)}
              onBlur={() => commitField('smtpPort')}
              placeholder="587"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">SMTP Username</label>
            <input 
              type="text" 
              className="w-full p-3 rounded-xl border border-gray-400 bg-gray-50 focus:ring-2 focus:ring-church-500"
              value={draft.smtpUser ?? ''}
              onChange={(e) => setField('smtpUser', e.target.value)}
              onBlur={() => commitField('smtpUser')}
              placeholder="user@example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">SMTP Password</label>
            <input 
              type="password" 
              className="w-full p-3 rounded-xl border border-gray-400 bg-gray-50 focus:ring-2 focus:ring-church-500"
              value={draft.smtpPassword ?? ''}
              autoComplete="new-password"
              placeholder={smtp?.hasPassword ? '•••••••• saved; type to replace' : ''}
              onChange={(e) => setField('smtpPassword', e.target.value)}
              onBlur={() => commitField('smtpPassword')}
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-2">From Email Address</label>
            <input 
              type="email" 
              className="w-full p-3 rounded-xl border border-gray-400 bg-gray-50 focus:ring-2 focus:ring-church-500"
              value={draft.smtpFrom ?? ''}
              onChange={(e) => setField('smtpFrom', e.target.value)}
              onBlur={() => commitField('smtpFrom')}
              placeholder="noreply@church.com"
            />
          </div>
        </div>

        <h4 className="font-bold text-gray-800 mb-4 border-b pb-2">Default Recipients (Comma separated)</h4>
        <div className="grid grid-cols-1 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Accounting Report Recipients</label>
            <input 
              type="text" 
              className="w-full p-3 rounded-xl border border-gray-400 bg-gray-50 focus:ring-2 focus:ring-church-500"
              value={draft.accountingRecipients ?? ''}
              onChange={(e) => setField('accountingRecipients', e.target.value)}
              onBlur={() => commitField('accountingRecipients')}
              placeholder="treasurer@church.com, pastor@church.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Envelope Report Recipients</label>
            <input 
              type="text" 
              className="w-full p-3 rounded-xl border border-gray-400 bg-gray-50 focus:ring-2 focus:ring-church-500"
              value={draft.envelopeRecipients ?? ''}
              onChange={(e) => setField('envelopeRecipients', e.target.value)}
              onBlur={() => commitField('envelopeRecipients')}
              placeholder="envelopesteward@church.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Bank Deposit Slip Recipients</label>
            <input 
              type="text" 
              className="w-full p-3 rounded-xl border border-gray-400 bg-gray-50 focus:ring-2 focus:ring-church-500"
              value={draft.depositRecipients ?? ''}
              onChange={(e) => setField('depositRecipients', e.target.value)}
              onBlur={() => commitField('depositRecipients')}
              placeholder="treasurer@church.com"
            />
          </div>
        </div>
      </div>

      {/* Fund Management */}
      <div className="bg-white p-8 rounded-3xl shadow-xl border border-gray-100">
        <h3 className="text-xl font-bold text-gray-800 mb-6 flex items-center gap-2">
          <Layers className="w-5 h-5 text-church-500" /> Fund Designation Management
        </h3>

        <div className="space-y-6">
          <form onSubmit={handleAddFund} className="flex gap-4">
            <input 
              type="text" 
              placeholder="Add new fund name..."
              className="flex-1 p-3 rounded-xl border border-gray-400 bg-gray-50 focus:ring-2 focus:ring-church-500"
              value={newFundName}
              onChange={(e) => setNewFundName(e.target.value)}
            />
            <button 
              type="submit" 
              className="bg-church-900 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 hover:bg-church-800 transition-colors"
            >
              <Plus className="w-4 h-4" /> Add Fund
            </button>
          </form>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
             {funds?.map(fund => (
               <div key={fund.id} className={`p-4 rounded-xl border flex justify-between items-center ${fund.isActive ? 'bg-white border-gray-200' : 'bg-gray-50 border-gray-100 opacity-60'}`}>
                 <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${fund.isActive ? 'bg-green-500' : 'bg-gray-300'}`} />
                    <span className={`font-bold ${fund.isActive ? 'text-gray-800' : 'text-gray-400'}`}>{fund.name}</span>
                    {fund.isSystem && <span className="text-[10px] bg-blue-50 text-blue-600 px-2 py-0.5 rounded font-bold uppercase">System</span>}
                 </div>
                 <button 
                   onClick={() => fund.id && toggleFundStatus(fund.id, fund.isActive)}
                   className={`p-2 rounded-lg transition-colors ${fund.isActive ? 'text-gray-400 hover:bg-red-50 hover:text-red-500' : 'text-green-500 hover:bg-green-50'}`}
                   title={fund.isActive ? "Deactivate Fund" : "Activate Fund"}
                 >
                   {fund.isActive ? <XCircle className="w-5 h-5" /> : <CheckCircle className="w-5 h-5" />}
                 </button>
               </div>
             ))}
          </div>
        </div>
      </div>

      {/* Internal Accounts Management */}
      <div className="bg-white p-8 rounded-3xl shadow-xl border border-gray-100">
        <h3 className="text-xl font-bold text-gray-800 mb-6 flex items-center gap-2">
          <Layers className="w-5 h-5 text-church-500" /> Internal Accounts Management
        </h3>

        <div className="space-y-6">
          <form onSubmit={handleAddInternalAccount} className="flex gap-4">
            <input 
              type="text" 
              placeholder="Add new internal account..."
              className="flex-1 p-3 rounded-xl border border-gray-400 bg-gray-50 focus:ring-2 focus:ring-church-500"
              value={newInternalAccountName}
              onChange={(e) => setNewInternalAccountName(e.target.value)}
            />
            <button 
              type="submit" 
              className="bg-church-900 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 hover:bg-church-800 transition-colors"
            >
              <Plus className="w-4 h-4" /> Add Account
            </button>
          </form>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
             {internalAccounts?.map(account => (
               <div key={account.id} className={`p-4 rounded-xl border flex justify-between items-center ${account.isActive ? 'bg-white border-gray-200' : 'bg-gray-50 border-gray-100 opacity-60'}`}>
                 <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${account.isActive ? 'bg-green-500' : 'bg-gray-300'}`} />
                    <span className={`font-bold ${account.isActive ? 'text-gray-800' : 'text-gray-400'}`}>{account.name}</span>
                 </div>
                 <button 
                   onClick={() => account.id && toggleInternalAccountStatus(account.id, account.isActive)}
                   className={`p-2 rounded-lg transition-colors ${account.isActive ? 'text-gray-400 hover:bg-red-50 hover:text-red-500' : 'text-green-500 hover:bg-green-50'}`}
                   title={account.isActive ? "Deactivate Account" : "Activate Account"}
                 >
                   {account.isActive ? <XCircle className="w-5 h-5" /> : <CheckCircle className="w-5 h-5" />}
                 </button>
               </div>
             ))}
          </div>
        </div>
      </div>

      {/* Giver Registry Management */}
      <div className="bg-white p-8 rounded-3xl shadow-xl border border-gray-100">
        <h3 className="text-xl font-bold text-gray-800 mb-6 flex items-center gap-2">
          <Users className="w-5 h-5 text-church-500" /> Giver Registry Management
        </h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="p-6 bg-gray-50 rounded-2xl border border-gray-200">
            <h4 className="font-bold text-lg mb-2 text-gray-800">Export Registry</h4>
            <p className="text-sm text-gray-500 mb-4">Download the full list of givers as a CSV file for editing in Excel or Google Sheets.</p>
            <button 
              onClick={handleExportGivers}
              className="w-full bg-white border border-gray-500 text-gray-700 font-bold py-3 rounded-xl hover:bg-gray-100 transition-colors flex justify-center gap-2 items-center"
            >
              <Download className="w-5 h-5" /> Export CSV
            </button>
          </div>

          <div className="p-6 bg-gray-50 rounded-2xl border border-gray-200">
            <h4 className="font-bold text-lg mb-2 text-gray-800">Import Registry</h4>
            <p className="text-sm text-gray-500 mb-4">Upload a CSV file to replace the current list. <span className="text-red-500 font-bold">Replaces all existing givers.</span></p>
            <button 
              onClick={handleImportClick}
              disabled={isImporting}
              className={`w-full bg-church-900 text-white font-bold py-3 rounded-xl hover:bg-church-800 transition-colors flex justify-center gap-2 items-center ${isImporting ? 'opacity-50 cursor-wait' : ''}`}
            >
              {isImporting ? (
                <>
                  <RefreshCw className="w-5 h-5 animate-spin" /> Importing...
                </>
              ) : (
                <>
                  <Upload className="w-5 h-5" /> Import CSV
                </>
              )}
            </button>
            <input 
              type="file" 
              ref={fileInputRef}
              onChange={handleFileChange} 
              className="hidden" 
              accept=".csv" 
            />
          </div>
        </div>
      </div>

      {/* Backup/Restore */}
      <div className="bg-gradient-to-br from-gray-900 to-church-900 p-8 rounded-3xl shadow-xl text-white">
        <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-yellow-500" /> Data Management
        </h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="bg-white/10 p-6 rounded-2xl backdrop-blur-sm">
            <h4 className="font-bold text-lg mb-2">Download a Copy</h4>
            <p className="text-sm text-gray-300 mb-4">Your data is stored and backed up in the cloud. Download a copy of everything (givers, batches, donations, sign-offs) as a JSON file for your own records.</p>
            <button 
              onClick={handleBackup}
              className="w-full bg-church-gold text-church-900 font-bold py-3 rounded-xl hover:bg-yellow-400 transition-colors flex justify-center gap-2 items-center"
            >
              <Download className="w-5 h-5" /> Generate Backup
            </button>
            {backupUrl && (
              <a 
                href={backupUrl} 
                download={`safetrack_backup_${new Date().toISOString().split('T')[0]}.json`}
                className="block mt-3 text-center text-sm text-green-300 underline"
              >
                Click here to download file
              </a>
            )}
          </div>

          <div className="bg-white/10 p-6 rounded-2xl backdrop-blur-sm border border-red-500/30">
            <h4 className="font-bold text-lg mb-2">Import from SafeTrack (offline version)</h4>
            <p className="text-sm text-gray-300 mb-4">Move your history in from a backup file made by the original browser-only SafeTrack. Works once, into a church with no batches yet. Finalized batches stay finalized with their original tellers.</p>
            <label className={`${isAdmin ? '' : 'pointer-events-none opacity-50 '}w-full bg-red-900/50 text-red-200 border border-red-500/50 font-bold py-3 rounded-xl hover:bg-red-900 transition-colors flex justify-center gap-2 items-center cursor-pointer`}>
              <Upload className="w-5 h-5" /> Import Backup File
              <input type="file" onChange={handleRestore} className="hidden" accept=".json" />
            </label>
          </div>
        </div>
      </div>

      {/* Universal Modal */}
      {modal.isOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl">
            <h3 className="text-xl font-bold text-gray-800 mb-4">
              {modal.type === 'confirm' ? 'Please Confirm' : 'Notice'}
            </h3>
            <p className="text-gray-600 mb-8 whitespace-pre-wrap">{modal.message}</p>
            <div className="flex gap-4">
              {modal.type === 'confirm' && (
                <button 
                  onClick={modal.onCancel}
                  className="flex-1 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition-colors"
                >
                  Cancel
                </button>
              )}
              <button 
                onClick={modal.onConfirm}
                className={`flex-1 py-3 font-bold rounded-xl transition-colors shadow-lg ${
                  modal.type === 'confirm' 
                    ? 'bg-red-600 text-white hover:bg-red-700' 
                    : 'bg-church-900 text-white hover:bg-church-800'
                }`}
              >
                {modal.type === 'confirm' ? 'Proceed' : 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Settings;