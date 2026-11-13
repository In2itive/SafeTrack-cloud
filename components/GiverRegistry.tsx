import React, { useState } from 'react';
import { useLive, listGivers, getNextEnvelopeNumber, addGiver, updateGiver } from '../services/repo';
import DataTable from './DataTable';
import { UserPlus, Search, User, MapPin, Mail, CreditCard, Smartphone, Pencil, Plus } from 'lucide-react';
import { Giver } from '../types';

const GiverRegistry: React.FC = () => {
  const givers = useLive(listGivers);
  const [saveError, setSaveError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [nextEnv, setNextEnv] = useState<number>(0);
  const [search, setSearch] = useState('');
  
  // Initial Form State
  const initialForm: Partial<Giver> = {
    name: '',
    name2: '',
    email: '',
    email2: '',
    address1: '',
    address2: '',
    address3: '',
    eTransferId: '',
    eTransferId2: '',
    pushPayId: ''
  };

  const [formData, setFormData] = useState<Partial<Giver>>(initialForm);

  const openNewGiverModal = async () => {
    setFormData(initialForm);
    const env = await getNextEnvelopeNumber();
    setNextEnv(env);
    setShowModal(true);
  };

  const openEditGiverModal = (giver: Giver) => {
    setFormData({ ...giver });
    setNextEnv(giver.envelopeNumber);
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name) return;

    const payload = {
      name: formData.name,
      name2: formData.name2,
      email: formData.email,
      email2: formData.email2,
      address1: formData.address1,
      address2: formData.address2,
      address3: formData.address3,
      eTransferId: formData.eTransferId,
      eTransferId2: formData.eTransferId2,
      pushPayId: formData.pushPayId
    };

 try {
      setSaveError('');
      if (formData.id) {
        await updateGiver(formData.id, payload);
      } else {
        // The database assigns the envelope number atomically (no two tellers can get the same one)
        await addGiver(payload as Giver);
      }
    } catch (err: any) {
      setSaveError(err.message || 'Could not save giver');
      return;
    }
    
    setShowModal(false);
    setFormData(initialForm);
  };

  const q = search.trim().toLowerCase();
  const filteredGivers = givers?.filter(g => !q ||
    [g.name, g.name2, g.email, g.email2, g.address1, g.address2, g.eTransferId, g.eTransferId2, g.pushPayId]
      .some(v => v?.toLowerCase().includes(q)) ||
    g.envelopeNumber.toString() === q || g.envelopeNumber.toString().startsWith(q)
  );

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-bold text-gray-800">Giver Registry</h2>
          <p className="text-gray-500">Manage church members and digital IDs.</p>
        </div>
        <button 
          onClick={openNewGiverModal}
          className="bg-church-500 hover:bg-church-900 text-white px-6 py-3 rounded-2xl shadow-lg flex items-center gap-2 transition-all font-semibold"
        >
          <UserPlus className="w-5 h-5" />
          Register New Giver
        </button>
      </div>

      {/* Search Bar */}
      <div className="relative">
        <Search className="absolute left-4 top-3.5 text-gray-400 w-5 h-5" />
        <input 
          type="text" 
          placeholder="Search by name, envelope #, email, address, or e-Transfer / PushPay ID..." 
          className="w-full pl-12 pr-4 py-3 rounded-2xl border-none shadow-md focus:ring-2 focus:ring-church-500 bg-gray-50"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Giver table */}
      <DataTable<Giver>
        rows={filteredGivers}
        rowKey={g => g.id!}
        initialSort={{ key: 'env', dir: 'asc' }}
        onRowClick={openEditGiverModal}
        countLabel={n => `${n} giver${n === 1 ? '' : 's'}${search ? ` matching "${search}"` : ''}`}
        empty={search ? 'No givers match that search.' : 'No givers yet. Register the first one.'}
        columns={[
          {
            key: 'env', label: 'Env #', className: 'w-20', sortValue: g => g.envelopeNumber,
            render: g => <span className="inline-block min-w-[3rem] text-center font-bold text-church-900 bg-blue-50 rounded-md px-2 py-0.5">{g.envelopeNumber}</span>,
          },
          {
            key: 'name', label: 'Name', sortValue: g => g.name,
            render: g => (
              <div>
                <div className="font-semibold text-gray-800">{g.name}</div>
                {g.name2 && <div className="text-xs text-church-500">& {g.name2}</div>}
              </div>
            ),
          },
          {
            key: 'address', label: 'Address', className: 'hidden lg:table-cell', sortValue: g => g.address1 || null,
            render: g => (g.address1 || g.address2)
              ? <div className="text-gray-600 leading-snug">{[g.address1, g.address2, g.address3].filter(Boolean).join(', ')}</div>
              : <span className="text-xs text-gray-300 italic">none</span>,
          },
          {
            key: 'email', label: 'Email', className: 'hidden md:table-cell', sortValue: g => g.email || null,
            render: g => g.email
              ? <div className="text-gray-600 truncate max-w-[16rem]">{g.email}{g.email2 && <div className="text-xs text-gray-400">{g.email2}</div>}</div>
              : <span className="text-xs text-gray-300 italic">none</span>,
          },
          {
            key: 'ids', label: 'Digital IDs', className: 'hidden xl:table-cell',
            sortValue: g => g.eTransferId || g.pushPayId || null,
            render: g => (
              <div className="flex flex-wrap gap-1">
                {g.eTransferId && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-50 text-green-700 text-xs border border-green-100" title="e-Transfer ID"><Smartphone className="w-3 h-3" />{g.eTransferId}</span>}
                {g.eTransferId2 && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-50/50 text-green-600 text-xs border border-green-100" title="Second e-Transfer ID"><Smartphone className="w-3 h-3" />{g.eTransferId2}</span>}
                {g.pushPayId && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-orange-50 text-orange-700 text-xs border border-orange-100" title="PushPay ID"><CreditCard className="w-3 h-3" />{g.pushPayId}</span>}
                {!g.eTransferId && !g.eTransferId2 && !g.pushPayId && <span className="text-xs text-gray-300">-</span>}
              </div>
            ),
          },
          {
            key: 'edit', label: '', className: 'w-12', align: 'right',
            render: g => (
              <button
                onClick={e => { e.stopPropagation(); openEditGiverModal(g); }}
                className="p-1.5 text-gray-300 group-hover:text-church-500 hover:bg-church-50 rounded-lg"
                title="Edit giver" aria-label={`Edit ${g.name}`}
              >
                <Pencil className="w-4 h-4" />
              </button>
            ),
          },
        ]}
      />

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl p-6 w-full max-w-2xl shadow-2xl overflow-y-auto max-h-[90vh]">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-2xl font-bold text-gray-800">{formData.id ? 'Edit Profile' : 'New Profile'}</h3>
              <div className="bg-blue-50 px-4 py-2 rounded-xl border border-blue-100">
                <span className="text-xs font-bold text-church-900 uppercase block">Envelope</span>
                <span className="text-2xl font-bold text-church-500">#{nextEnv}</span>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              {saveError && <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm border border-red-100">{saveError}</div>}
              
              {/* Names Section */}
              <div className="space-y-4">
                <h4 className="text-sm font-bold text-gray-400 uppercase tracking-wider border-b border-gray-100 pb-1">Identity</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Primary Name <span className="text-red-400">*</span></label>
                    <input 
                      required
                      placeholder="e.g. John Doe"
                      className="w-full p-3 rounded-xl border border-gray-400 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
                      value={formData.name}
                      onChange={e => setFormData({...formData, name: e.target.value})}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Joint / Second Name</label>
                    <input 
                      placeholder="e.g. Jane Doe"
                      className="w-full p-3 rounded-xl border border-gray-400 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
                      value={formData.name2}
                      onChange={e => setFormData({...formData, name2: e.target.value})}
                    />
                  </div>
                </div>
              </div>

              {/* Contact Section */}
              <div className="space-y-4">
                <h4 className="text-sm font-bold text-gray-400 uppercase tracking-wider border-b border-gray-100 pb-1">Location & Contact</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Primary Email</label>
                    <input 
                      type="email"
                      placeholder="primary@email.com"
                      className="w-full p-3 rounded-xl border border-gray-400 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
                      value={formData.email}
                      onChange={e => setFormData({...formData, email: e.target.value})}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Secondary Email</label>
                    <input 
                      type="email"
                      placeholder="spouse@email.com"
                      className="w-full p-3 rounded-xl border border-gray-400 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
                      value={formData.email2}
                      onChange={e => setFormData({...formData, email2: e.target.value})}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">Mailing Address</label>
                  <input 
                    placeholder="Address Line 1"
                    className="w-full p-3 rounded-xl border border-gray-400 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
                    value={formData.address1}
                    onChange={e => setFormData({...formData, address1: e.target.value})}
                  />
                  <input 
                    placeholder="Address Line 2 (Optional)"
                    className="w-full p-3 rounded-xl border border-gray-400 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
                    value={formData.address2}
                    onChange={e => setFormData({...formData, address2: e.target.value})}
                  />
                  <input 
                    placeholder="Address Line 3 (City, State, Zip)"
                    className="w-full p-3 rounded-xl border border-gray-400 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
                    value={formData.address3}
                    onChange={e => setFormData({...formData, address3: e.target.value})}
                  />
                </div>
              </div>

              {/* IDs Section */}
              <div className="space-y-4">
                <h4 className="text-sm font-bold text-gray-400 uppercase tracking-wider border-b border-gray-100 pb-1">Digital Identifiers</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-3">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">eTransfer ID / Phone 1</label>
                        <div className="relative">
                        <Smartphone className="absolute left-3 top-3.5 text-gray-400 w-4 h-4" />
                        <input 
                            placeholder="e.g. 555-0199"
                            className="w-full pl-10 p-3 rounded-xl border border-gray-400 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
                            value={formData.eTransferId}
                            onChange={e => setFormData({...formData, eTransferId: e.target.value})}
                        />
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">eTransfer ID / Phone 2</label>
                        <div className="relative">
                        <Smartphone className="absolute left-3 top-3.5 text-gray-400 w-4 h-4" />
                        <input 
                            placeholder="e.g. spouse@mail.com"
                            className="w-full pl-10 p-3 rounded-xl border border-gray-400 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
                            value={formData.eTransferId2}
                            onChange={e => setFormData({...formData, eTransferId2: e.target.value})}
                        />
                        </div>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">PushPay ID</label>
                    <div className="relative">
                      <CreditCard className="absolute left-3 top-3.5 text-gray-400 w-4 h-4" />
                      <input 
                        placeholder="ID String"
                        className="w-full pl-10 p-3 rounded-xl border border-gray-400 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
                        value={formData.pushPayId}
                        onChange={e => setFormData({...formData, pushPayId: e.target.value})}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex gap-4 pt-4 border-t border-gray-100">
                <button 
                  type="button" 
                  onClick={() => setShowModal(false)}
                  className="flex-1 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition-colors"
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  className="flex-1 py-3 bg-church-900 text-white font-bold rounded-xl hover:bg-blue-800 transition-colors shadow-lg"
                >
                  {formData.id ? 'Save Changes' : 'Create Profile'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default GiverRegistry;