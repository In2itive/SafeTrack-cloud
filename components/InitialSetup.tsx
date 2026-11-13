import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { ShieldCheck, User, Lock, Mail, Church, MailCheck } from 'lucide-react';

const inputClass = "w-full pl-10 p-3 rounded-xl border border-gray-400 focus:ring-2 focus:ring-church-500 outline-none";

/**
 * Two modes:
 *  - signed out: create the administrator's login and the church in one step
 *  - signed in without a church (e.g. after confirming email): name the church
 */
const InitialSetup: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
  const { signUp, finishChurchSetup, needsChurch, logout } = useAuth();
  const [formData, setFormData] = useState({ name: '', churchName: '', email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (needsChurch) {
      setBusy(true);
      try {
        await finishChurchSetup(formData.churchName.trim(), formData.name.trim());
      } catch (err: any) {
        setError(err.message || 'Failed to create the church.');
      } finally {
        setBusy(false);
      }
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (formData.password.length < 10) {
      setError("Use at least 10 characters for the administrator password");
      return;
    }
    setBusy(true);
    try {
      const r = await signUp(formData.email, formData.password, formData.name.trim(), formData.churchName.trim());
      if (!r.ok) setError(r.error || 'Failed to create the account.');
      else if (r.needsConfirmation) setCheckEmail(true);
    } finally {
      setBusy(false);
    }
  };

  if (checkEmail) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-3xl shadow-xl p-8 w-full max-w-md text-center">
          <MailCheck className="w-12 h-12 text-church-600 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-gray-800">Confirm your email</h1>
          <p className="text-gray-500 mt-3">
            We sent a link to <strong>{formData.email}</strong>. Click it, then come back and sign in;
            you'll be asked to name your church.
          </p>
          {onBack && (
            <button onClick={onBack} className="mt-6 text-church-600 font-semibold hover:underline">Back to sign in</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-xl p-6 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-church-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <ShieldCheck className="w-8 h-8 text-church-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-800">Welcome to SafeTrack</h1>
          <p className="text-gray-500 mt-2">
            {needsChurch ? 'Name your church to finish setup.' : 'Create your church and its Administrator account.'}
          </p>
        </div>

        {error && (
          <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm mb-6 border border-red-100">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">Church Name</label>
            <div className="relative">
              <Church className="absolute left-3 top-3 w-5 h-5 text-gray-400" />
              <input type="text" required className={inputClass} placeholder="Grace Community Church"
                value={formData.churchName} onChange={e => setFormData({ ...formData, churchName: e.target.value })} />
            </div>
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">Your Name</label>
            <div className="relative">
              <User className="absolute left-3 top-3 w-5 h-5 text-gray-400" />
              <input type="text" required className={inputClass} placeholder="John Doe"
                value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} />
            </div>
          </div>

          {!needsChurch && (
            <>
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Email Address</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-3 w-5 h-5 text-gray-400" />
                  <input type="email" required autoComplete="off" className={inputClass} placeholder="john@example.com"
                    value={formData.email} onChange={e => setFormData({ ...formData, email: e.target.value })} />
                </div>
              </div>

              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-3 w-5 h-5 text-gray-400" />
                  <input type="password" required autoComplete="new-password" className={inputClass} placeholder="At least 10 characters"
                    value={formData.password} onChange={e => setFormData({ ...formData, password: e.target.value })} />
                </div>
              </div>

              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Confirm Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-3 w-5 h-5 text-gray-400" />
                  <input type="password" required autoComplete="new-password" className={inputClass} placeholder="••••••••••"
                    value={formData.confirmPassword} onChange={e => setFormData({ ...formData, confirmPassword: e.target.value })} />
                </div>
              </div>
            </>
          )}

          <button type="submit" disabled={busy}
            className="w-full bg-church-900 text-white font-bold py-3 rounded-xl hover:bg-church-800 transition-colors shadow-lg mt-6 disabled:opacity-50">
            {busy ? 'Setting up…' : needsChurch ? 'Create Church' : 'Create Church & Admin Account'}
          </button>
        </form>

        <div className="text-center text-sm text-gray-500 mt-6">
          {needsChurch ? (
            <button onClick={logout} className="hover:underline">Sign out</button>
          ) : onBack ? (
            <>Already set up? <button onClick={onBack} className="text-church-600 font-semibold hover:underline">Sign in</button></>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default InitialSetup;
