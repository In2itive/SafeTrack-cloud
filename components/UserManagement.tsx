import React, { useState } from 'react';
import { User, UserRole } from '../types';
import { useLive, listMembers, addMember, updateMember, removeMember } from '../services/repo';
import { useAuth } from '../contexts/AuthContext';
import { Users, Plus, Edit, Trash2, Shield, Mail, Lock, User as UserIcon, X, Check } from 'lucide-react';

const UserManagement = () => {
  const { user: currentUser } = useAuth();
  const [loadError, setLoadError] = useState('');
  const users = useLive(() => listMembers().catch(e => { setLoadError(e.message); return [] as User[]; }));
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [userToDelete, setUserToDelete] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    role: UserRole.Teller,
    password: ''
  });
  const [error, setError] = useState('');

  if (currentUser?.role !== UserRole.Administrator) {
    return (
      <div className="p-8 text-center">
        <Shield className="w-16 h-16 text-red-500 mx-auto mb-4" />
        <h2 className="text-2xl font-bold text-gray-800">Access Denied</h2>
        <p className="text-gray-500">You do not have permission to view this page.</p>
      </div>
    );
  }

  const handleOpenModal = (user?: User) => {
    if (user) {
      setEditingUser(user);
      setFormData({
        name: user.name,
        email: user.email,
        role: user.role,
        password: '' // Don't show password
      });
    } else {
      setEditingUser(null);
      setFormData({
        name: '',
        email: '',
        role: UserRole.Teller,
        password: ''
      });
    }
    setError('');
    setIsModalOpen(true);
  };

  const handleDelete = (id: string) => {
    setUserToDelete(id);
  };

  const confirmDelete = async () => {
    if (userToDelete) {
      try {
        await removeMember(userToDelete);
      } catch (err: any) {
        alert(err.message || 'Could not remove user');
      }
      setUserToDelete(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      if (editingUser && editingUser.id) {
        if (formData.password && formData.password.length < 8) {
          setError("Passwords must be at least 8 characters");
          return;
        }
        await updateMember(editingUser.id, { name: formData.name, role: formData.role, password: formData.password });
      } else {
        if (!formData.password || formData.password.length < 8) {
          setError("A temporary password of at least 8 characters is required for new users");
          return;
        }
        await addMember({ email: formData.email, name: formData.name, role: formData.role, password: formData.password });
      }
      setIsModalOpen(false);
    } catch (err: any) {
      setError(err.message || "Failed to save user");
    }
  };

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-800 flex items-center gap-3">
            <Users className="w-8 h-8 text-church-600" />
            User Management
          </h1>
          <p className="text-gray-500 mt-1">Manage system access and roles</p>
        </div>
        <button
          onClick={() => handleOpenModal()}
          className="bg-church-900 text-white px-6 py-3 rounded-xl font-bold shadow-lg hover:bg-church-800 transition-all flex items-center gap-2"
        >
          <Plus className="w-5 h-5" /> Add New User
        </button>
      </div>

      {loadError && (
        <div className="bg-red-50 text-red-600 p-3 rounded-xl text-sm mb-6 border border-red-100">{loadError}</div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {users?.map(user => (
          <div key={user.id} className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 hover:shadow-md transition-shadow relative group">
            <div className="flex justify-between items-start mb-4">
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                user.role === UserRole.Administrator ? 'bg-purple-100 text-purple-600' :
                user.role === UserRole.Treasurer ? 'bg-green-100 text-green-600' :
                user.role === UserRole.Envelope ? 'bg-blue-100 text-blue-600' :
                'bg-gray-100 text-gray-600'
              }`}>
                <Shield className="w-6 h-6" />
              </div>
              <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button 
                  onClick={() => handleOpenModal(user)}
                  className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 hover:text-church-600"
                >
                  <Edit className="w-4 h-4" />
                </button>
                {user.id !== currentUser?.id && (
                  <button 
                    onClick={() => user.id && handleDelete(user.id)}
                    className="p-2 hover:bg-red-50 rounded-lg text-gray-500 hover:text-red-600"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            
            <h3 className="text-lg font-bold text-gray-800">{user.name}</h3>
            <p className="text-sm text-gray-500 mb-4">{user.isActive === false ? 'Inactive' : 'Active'}</p>
            
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Shield className="w-4 h-4 text-gray-400" />
                <span className="font-medium bg-gray-100 px-2 py-0.5 rounded text-xs uppercase tracking-wide">
                  {user.role}
                </span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Mail className="w-4 h-4 text-gray-400" />
                {user.email}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 w-full max-w-md shadow-2xl animate-fade-in-up">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-bold text-gray-800">
                {editingUser ? 'Edit User' : 'Create New User'}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-full">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            {error && (
              <div className="bg-red-50 text-red-600 p-3 rounded-xl text-sm mb-6 border border-red-100">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Full Name</label>
                <div className="relative">
                  <UserIcon className="absolute left-3 top-3 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    required
                    className="w-full pl-9 p-2.5 rounded-xl border border-gray-400 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-church-500 outline-none text-sm"
                    value={formData.name}
                    onChange={e => setFormData({...formData, name: e.target.value})}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-3 w-4 h-4 text-gray-400" />
                  <input
                    type="email"
                    required
                    disabled={!!editingUser}
                    autoComplete="off"
                    className="w-full pl-9 p-2.5 rounded-xl border border-gray-400 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-church-500 outline-none text-sm"
                    value={formData.email}
                    onChange={e => setFormData({...formData, email: e.target.value})}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Role</label>
                <div className="relative">
                  <Shield className="absolute left-3 top-3 w-4 h-4 text-gray-400" />
                  <select
                    className="w-full pl-9 p-2.5 rounded-xl border border-gray-400 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-church-500 outline-none text-sm appearance-none"
                    value={formData.role}
                    onChange={e => setFormData({...formData, role: e.target.value as UserRole})}
                  >
                    {Object.values(UserRole).map(role => (
                      <option key={role} value={role}>{role}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">
                  {editingUser ? 'New Password (Optional)' : 'Password'}
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-3 w-4 h-4 text-gray-400" />
                  <input
                    type="password"
                    className="w-full pl-9 p-2.5 rounded-xl border border-gray-400 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-church-500 outline-none text-sm"
                    placeholder={editingUser ? "Leave blank to keep current" : "••••••••"}
                    value={formData.password}
                    onChange={e => setFormData({...formData, password: e.target.value})}
                  />
                </div>
              </div>

              <button
                type="submit"
                className="w-full bg-church-900 text-white font-bold py-3 rounded-xl hover:bg-church-800 transition-all shadow-lg mt-4 flex items-center justify-center gap-2"
              >
                <Check className="w-5 h-5" /> Save User
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {userToDelete && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl animate-fade-in-up border border-gray-100">
            <div className="flex justify-center mb-4">
              <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
                <Trash2 className="w-6 h-6 text-red-600" />
              </div>
            </div>
            <h3 className="text-xl font-bold text-center text-gray-800 mb-2">Delete User</h3>
            <p className="text-center text-gray-600 mb-6">
              Are you sure you want to delete this user? This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setUserToDelete(null)}
                className="flex-1 py-3 rounded-xl font-bold bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="flex-1 py-3 rounded-xl font-bold bg-red-600 text-white hover:bg-red-700 transition-colors shadow-lg shadow-red-200"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UserManagement;
