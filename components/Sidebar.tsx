import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Users, FilePlus, ClipboardList, Settings, LogOut, ShieldCheck, UserCog, KeyRound, CreditCard } from 'lucide-react';
import ChangePasswordModal from './ChangePasswordModal';
import { useAuth } from '../contexts/AuthContext';
import { UserRole } from '../types';

const Sidebar: React.FC = () => {
  const { logout, user, secondaryUser, churchName } = useAuth();
  const [showPw, setShowPw] = useState(false);

  const navClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
      isActive 
        ? 'bg-church-500 text-white shadow-lg' 
        : 'text-blue-100 hover:bg-church-800 hover:text-white'
    }`;

  return (
    <div className="w-64 bg-church-900 h-screen fixed left-0 top-0 flex flex-col justify-between p-4 shadow-2xl z-50">
      <div>
        <div className="flex items-center gap-2 mb-10 px-2 mt-4">
          <ShieldCheck className="w-8 h-8 text-church-gold" />
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">SafeTrack</h1>
            <p className="text-xs text-blue-300 truncate max-w-[10rem]" title={churchName}>{churchName || 'Donation Vault'}</p>
          </div>
        </div>

        <nav className="space-y-2">
          <NavLink to="/" className={navClass}>
            <LayoutDashboard className="w-5 h-5" />
            Dashboard
          </NavLink>
          <NavLink to="/givers" className={navClass}>
            <Users className="w-5 h-5" />
            Giver Registry
          </NavLink>
          <NavLink to="/batch-entry" className={navClass}>
            <FilePlus className="w-5 h-5" />
            New Batch
          </NavLink>
          <NavLink to="/history" className={navClass}>
            <ClipboardList className="w-5 h-5" />
            Batch History
          </NavLink>
          {(user?.role === UserRole.Administrator || user?.role === UserRole.Treasurer) && (
            <NavLink to="/online-giving" className={navClass}>
              <CreditCard className="w-5 h-5" />
              Online Giving
            </NavLink>
          )}
          <NavLink to="/settings" className={navClass}>
            <Settings className="w-5 h-5" />
            Admin / Backup
          </NavLink>
          
          {user?.role === UserRole.Administrator && (
            <NavLink to="/admin/users" className={navClass}>
              <UserCog className="w-5 h-5" />
              User Management
            </NavLink>
          )}
        </nav>
      </div>

      <div className="mt-auto">
        <div className="px-4 py-2 mb-2 text-xs text-blue-300">
          Logged in as <span className="font-bold text-white">{user?.name}</span>
          {secondaryUser && (
            <>
              {' & '}
              <span className="font-bold text-white">{secondaryUser.name}</span>
            </>
          )}
        </div>
        <button 
          onClick={() => setShowPw(true)}
          className="w-full flex items-center justify-center gap-2 mb-3 px-4 py-2 text-xs font-bold rounded-xl text-blue-100 hover:bg-church-800 transition-colors"
        >
          <KeyRound className="w-3 h-3" />
          Change Passwords
        </button>
        <button 
          onClick={logout}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-blue-200 hover:bg-red-900/50 hover:text-red-200 transition-colors"
        >
          <LogOut className="w-5 h-5" />
          Lock Vault
        </button>
      </div>
      {showPw && <ChangePasswordModal onClose={() => setShowPw(false)} />}
    </div>
  );
};

export default Sidebar;
