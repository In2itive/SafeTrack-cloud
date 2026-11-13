import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Lock, User, LogIn, Users } from 'lucide-react';

const Login = () => {
  const { login, user, logout } = useAuth();
  const [formData, setFormData] = useState({
    username: '',
    password: ''
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    
    try {
      const success = await login(formData.username, formData.password);
      if (!success) {
        setError("Invalid username or password");
      } else {
        setFormData({ username: '', password: '' });
      }
    } catch (err) {
      setError("An error occurred during login");
    } finally {
      setLoading(false);
    }
  };

  const isSecondaryLogin = !!user;

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-xl p-6 w-full max-w-sm border border-gray-100">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-church-900 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg transform -rotate-3">
            {isSecondaryLogin ? <Users className="w-8 h-8 text-white" /> : <Lock className="w-8 h-8 text-white" />}
          </div>
          <h1 className="text-2xl font-bold text-gray-800">SafeTrack Vault</h1>
          <p className="text-gray-500 mt-2 text-sm">
            {isSecondaryLogin ? 'Second Teller Required' : 'Secure Access Required'}
          </p>
        </div>

        {isSecondaryLogin && (
          <div className="bg-blue-50 text-blue-700 p-3 rounded-xl text-sm mb-6 border border-blue-100 flex items-center justify-between">
            <span>Logged in as <strong>{user.name}</strong></span>
            <button onClick={logout} className="text-blue-600 hover:text-blue-800 font-semibold text-xs underline">
              Cancel
            </button>
          </div>
        )}

        {error && (
          <div className="bg-red-50 text-red-600 p-3 rounded-xl text-sm mb-6 border border-red-100 flex items-center gap-2">
            <span className="font-bold">Error:</span> {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
          <div>
            <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">
              {isSecondaryLogin ? 'Second Teller Username' : 'Username'}
            </label>
            <div className="relative">
              <User className="absolute left-3 top-3 w-5 h-5 text-gray-400" />
              <input
                type="text"
                required
                autoComplete="off"
                className="w-full pl-10 p-3 rounded-xl border border-gray-400 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-church-500 outline-none transition-all"
                placeholder={isSecondaryLogin ? "Enter second username" : "Enter your username"}
                value={formData.username}
                onChange={e => setFormData({...formData, username: e.target.value})}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-3 w-5 h-5 text-gray-400" />
              <input
                type="password"
                required
                autoComplete="new-password"
                className="w-full pl-10 p-3 rounded-xl border border-gray-400 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-church-500 outline-none transition-all"
                placeholder="••••••••"
                value={formData.password}
                onChange={e => setFormData({...formData, password: e.target.value})}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-church-900 text-white font-bold py-3 rounded-xl hover:bg-church-800 transition-all shadow-lg mt-6 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Verifying...' : (
              <>
                <LogIn className="w-5 h-5" /> {isSecondaryLogin ? 'Verify Second Teller' : 'Login to Vault'}
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;
