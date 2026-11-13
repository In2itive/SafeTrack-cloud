import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase, secondTellerClient } from '../services/supabase';
import { getMembership, createChurch, setCurrentChurch, notifyChange } from '../services/repo';
import { User, UserRole } from '../types';

/**
 * Two real Supabase sessions on one laptop:
 *  - `user`: the primary signed-in person. All reads/writes use this session.
 *  - `secondaryUser`: the second teller, signed in with their own password in
 *    a separate client. The database requires that session's sign_batch()
 *    call before a non-admin can finalize, so the pairing is verifiable,
 *    not just a UI gate.
 */
interface AuthContextType {
  user: User | null;
  secondaryUser: User | null;
  churchName: string;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Signed in, but not a member of any church yet: show church setup. */
  needsChurch: boolean;
  /** Login error / info shown on the login screen. */
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  signUp: (email: string, password: string, name: string, churchName: string) => Promise<{ ok: boolean; needsConfirmation?: boolean; error?: string }>;
  finishChurchSetup: (churchName: string, displayName: string) => Promise<void>;
  changePassword: (who: 'primary' | 'secondary', newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [secondaryUser, setSecondaryUser] = useState<User | null>(null);
  const [churchId, setChurchId] = useState<string | null>(null);
  const [churchName, setChurchName] = useState('');
  const [needsChurch, setNeedsChurch] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const loadPrimary = useCallback(async () => {
    const m = await getMembership(supabase);
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      setUser(null); setNeedsChurch(false); setCurrentChurch(null); setChurchId(null);
      return null;
    }
    if (!m) {
      setUser(null); setNeedsChurch(true); setCurrentChurch(null); setChurchId(null);
      return null;
    }
    setCurrentChurch(m.churchId);
    setChurchId(m.churchId);
    setChurchName(m.churchName);
    setUser(m.user);
    setNeedsChurch(false);
    return m;
  }, []);

  const loadSecondary = useCallback(async (primaryChurch: string | null, primaryUserId?: string) => {
    const { data } = await secondTellerClient.auth.getSession();
    if (!data.session || !primaryChurch) { setSecondaryUser(null); return; }
    const m = await getMembership(secondTellerClient);
    if (!m || m.churchId !== primaryChurch || m.user.id === primaryUserId) {
      await secondTellerClient.auth.signOut();
      setSecondaryUser(null);
      return;
    }
    setSecondaryUser(m.user);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const m = await loadPrimary();
        await loadSecondary(m?.churchId ?? null, m?.user.id);
      } catch (e) {
        console.error('Session restore failed:', e);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [loadPrimary, loadSecondary]);

  const login = async (email: string, password: string) => {
    if (!user) {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) return { ok: false, error: error.message === 'Invalid login credentials' ? 'Invalid email or password' : error.message };
      await loadPrimary();
      notifyChange();
      return { ok: true };
    }

    // Second teller
    const { error } = await secondTellerClient.auth.signInWithPassword({ email: email.trim(), password });
    if (error) return { ok: false, error: error.message === 'Invalid login credentials' ? 'Invalid email or password' : error.message };
    const m = await getMembership(secondTellerClient);
    if (!m || m.churchId !== churchId) {
      await secondTellerClient.auth.signOut();
      return { ok: false, error: 'That account is not a member of this church' };
    }
    if (m.user.id === user.id) {
      await secondTellerClient.auth.signOut();
      return { ok: false, error: 'The second teller must be a different person' };
    }
    setSecondaryUser(m.user);
    return { ok: true };
  };

  const logout = async () => {
    await Promise.all([secondTellerClient.auth.signOut(), supabase.auth.signOut()]);
    setUser(null); setSecondaryUser(null); setNeedsChurch(false);
    setCurrentChurch(null); setChurchId(null); setChurchName('');
  };

  const signUp = async (email: string, password: string, name: string, church: string) => {
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(), password,
      options: { data: { display_name: name, church_name: church } },
    });
    if (error) return { ok: false, error: error.message };
    if (!data.session) return { ok: true, needsConfirmation: true };
    await createChurch(church, name);
    await loadPrimary();
    return { ok: true };
  };

  const finishChurchSetup = async (church: string, displayName: string) => {
    await createChurch(church, displayName);
    await loadPrimary();
  };

  const changePassword = async (who: 'primary' | 'secondary', newPassword: string) => {
    const client = who === 'primary' ? supabase : secondTellerClient;
    const { error } = await client.auth.updateUser({ password: newPassword });
    if (error) throw new Error(error.message);
  };

  const isAuthenticated = !!user && (user.role === UserRole.Administrator || !!secondaryUser);

  return (
    <AuthContext.Provider value={{
      user, secondaryUser, churchName, isAuthenticated, isLoading, needsChurch,
      login, logout, signUp, finishChurchSetup, changePassword,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
