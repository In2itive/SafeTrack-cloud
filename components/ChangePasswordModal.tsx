import React, { useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

/** Lets each signed-in person (primary and, if present, second teller) change their own password. */
const ChangePasswordModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { user, secondaryUser, changePassword } = useAuth();
  const [who, setWho] = useState<'primary' | 'secondary'>('primary');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (pw.length < 8) return setMsg({ ok: false, text: 'Use at least 8 characters.' });
    if (pw !== confirm) return setMsg({ ok: false, text: 'Passwords do not match.' });
    setBusy(true);
    try {
      await changePassword(who, pw);
      setMsg({ ok: true, text: `Password changed for ${who === 'primary' ? user?.name : secondaryUser?.name}.` });
      setPw(''); setConfirm('');
    } catch (err: any) {
      setMsg({ ok: false, text: err.message || 'Could not change password.' });
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full p-3 rounded-xl border border-gray-400 focus:ring-2 focus:ring-church-500 outline-none";
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2"><KeyRound className="w-5 h-5" /> Change Password</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={submit} className="space-y-3" autoComplete="off">
          {secondaryUser && (
            <div className="flex gap-2">
              {(['primary', 'secondary'] as const).map(w => (
                <button type="button" key={w} onClick={() => setWho(w)}
                  className={`flex-1 py-2 rounded-lg text-sm font-semibold border ${who === w ? 'bg-church-900 text-white border-church-900' : 'border-gray-300 text-gray-600'}`}>
                  {w === 'primary' ? user?.name : secondaryUser.name}
                </button>
              ))}
            </div>
          )}
          <input type="password" autoComplete="new-password" placeholder="New password" className={input} value={pw} onChange={e => setPw(e.target.value)} />
          <input type="password" autoComplete="new-password" placeholder="Confirm new password" className={input} value={confirm} onChange={e => setConfirm(e.target.value)} />
          {msg && <p className={`text-sm ${msg.ok ? 'text-green-600' : 'text-red-600'}`}>{msg.text}</p>}
          <button type="submit" disabled={busy} className="w-full bg-church-900 text-white font-bold py-3 rounded-xl hover:bg-church-800 disabled:opacity-50">
            {busy ? 'Saving…' : 'Change Password'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default ChangePasswordModal;
