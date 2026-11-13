import React, { useState, useEffect } from 'react';
import { Lock, Shield } from 'lucide-react';

interface Props {
  onUnlock: () => void;
}

const LockScreen: React.FC<Props> = ({ onUnlock }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const [isSetup, setIsSetup] = useState(false);

  useEffect(() => {
    // Check if a password exists in localStorage (simulate persisted local config)
    const stored = localStorage.getItem('vault_password');
    if (!stored) {
      setIsSetup(true);
    }
  }, []);

  const handleAttempt = (e: React.FormEvent) => {
    e.preventDefault();
    const stored = localStorage.getItem('vault_password');
    
    if (isSetup) {
      localStorage.setItem('vault_password', password);
      sessionStorage.setItem('vault_unlocked', 'true');
      onUnlock();
    } else {
      if (password === stored) {
        sessionStorage.setItem('vault_unlocked', 'true');
        onUnlock();
      } else {
        setError(true);
        setPassword('');
      }
    }
  };

  return (
    <div className="min-h-screen bg-church-900 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl p-6 w-full max-w-md shadow-2xl text-center animate-fade-in-up">
        <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <Shield className="w-10 h-10 text-church-900" />
        </div>
        
        <h1 className="text-2xl font-bold text-gray-800 mb-2">SafeTrack Vault</h1>
        <p className="text-gray-500 mb-8">
          {isSetup ? "Create a Vault Password to secure local data." : "Enter Password to Open Safe."}
        </p>

        <form onSubmit={handleAttempt} className="space-y-4">
          <div className="relative">
            <Lock className="absolute left-4 top-3.5 text-gray-400 w-5 h-5" />
            <input 
              type="password" 
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(false); }}
              className={`w-full pl-12 pr-4 py-3 rounded-xl border ${error ? 'border-red-500 bg-red-50' : 'border-gray-400 bg-gray-50'} focus:ring-2 focus:ring-church-500 outline-none transition-all`}
              placeholder="Vault Password"
              autoFocus
            />
          </div>
          
          <button 
            type="submit" 
            className="w-full bg-church-gold hover:bg-yellow-400 text-church-900 font-bold py-3 rounded-xl transition-transform active:scale-95 shadow-lg"
          >
            {isSetup ? "Set Password & Enter" : "Unlock Vault"}
          </button>
        </form>
        
        {error && <p className="text-red-500 mt-4 text-sm font-semibold">Incorrect Password. Access Denied.</p>}
        
        <p className="mt-8 text-xs text-gray-400">
          Local-first secure storage. No data leaves this device without your action.
        </p>
      </div>
    </div>
  );
};

export default LockScreen;