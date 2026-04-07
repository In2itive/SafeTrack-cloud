import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getNextEnvelopeNumber, incrementEnvelopeNumber } from '../services/db';
import { UserPlus, Search, User, MapPin, Mail, CreditCard, Smartphone, Pencil, Plus } from 'lucide-react';
import { Giver } from '../types';

const GiverRegistry: React.FC = () => {
  const givers = useLiveQuery(() => db.givers.toArray());
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

    if (formData.id) {
      // Edit Mode
      await db.givers.update(formData.id, payload);
    } else {
      // Create Mode
      await db.givers.add({
        envelopeNumber: nextEnv,
        ...payload
      } as Giver);
      await incrementEnvelopeNumber();
    }
    
    setShowModal(false);
    setFormData(initialForm);
  };

  const filteredGivers = givers?.filter(g => 
    g.name.toLowerCase().includes(search.toLowerCase()) || 
    (g.name2 && g.name2.toLowerCase().includes(search.toLowerCase())) ||
    g.envelopeNumber.toString().includes(search) ||
    (g.eTransferId && g.eTransferId.toLowerCase().includes(search.toLowerCase()))
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
          placeholder="Search by name, envelope #, or ID..." 
          className="w-full pl-12 pr-4 py-3 rounded-2xl border-none shadow-md focus:ring-2 focus:ring-church-500 bg-gray-50"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Giver Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {filteredGivers?.map(giver => (
          <div key={giver.id} className="bg-white p-6 rounded-3xl shadow-md hover:shadow-xl transition-shadow border border-gray-100 flex flex-col h-full relative group">
             {/* Edit Button */}
             <button 
               onClick={() => openEditGiverModal(giver)}
               className="absolute top-6 right-6 p-2 text-gray-300 hover:text-church-500 hover:bg-church-50 rounded-full transition-colors opacity-0 group-hover:opacity-100"
               title="Edit Profile"
             >
               <Pencil className="w-5 h-5" />
             </button>

             <div className="flex justify-between items-start mb-4 pr-10">
                <div className="w-14 h-14 bg-church-900 rounded-2xl flex items-center justify-center text-white font-bold text-xl shadow-church-900/20 shadow-lg">
                  {giver.envelopeNumber}
                </div>
                <div className="p-2 bg-gray-50 rounded-full">
                  <User className="w-5 h-5 text-gray-400" />
                </div>
             </div>
             
             <div className="mb-4">
                <h3 className="text-lg font-bold text-gray-800 leading-tight">{giver.name}</h3>
                {giver.name2 && (
                  <p className="text-md font-medium text-church-500">& {giver.name2}</p>
                )}
             </div>

             <div className="space-y-2 mb-4 flex-1">
               {(giver.address1 || giver.address2 || giver.address3) ? (
                 <div className="flex gap-2 items-start text-sm text-gray-500">
                    <MapPin className="w-4 h-4 mt-1 shrink-0 opacity-50" />
                    <div className="leading-snug">
                      {giver.address1 && <div>{giver.address1}</div>}
                      {giver.address2 && <div>{giver.address2}</div>}
                      {giver.address3 && <div>{giver.address3}</div>}
                    </div>
                 </div>
               ) : (
                 <p className="text-xs text-gray-400 italic pl-6">No address on file</p>
               )}
               
               {(giver.email || giver.email2) && (
                 <div className="flex gap-2 items-start text-sm text-gray-500">
                   <Mail className="w-4 h-4 shrink-0 opacity-50 mt-0.5" />
                   <div className="truncate">
                      {giver.email && <div>{giver.email}</div>}
                      {giver.email2 && <div className="text-gray-400 text-xs">{giver.email2}</div>}
                   </div>
                 </div>
               )}
             </div>

             {/* IDs Footer */}
             <div className="pt-4 border-t border-gray-50 flex flex-wrap gap-2">
                {giver.eTransferId && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-green-50 text-green-700 text-xs font-bold border border-green-100" title="Primary eTransfer ID">
                    <Smartphone className="w-3 h-3" /> {giver.eTransferId}
                  </span>
                )}
                {giver.eTransferId2 && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-green-50/50 text-green-600 text-xs font-bold border border-green-100" title="Secondary eTransfer ID">
                    <Smartphone className="w-3 h-3" /> {giver.eTransferId2}
                  </span>
                )}
                {giver.pushPayId && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-orange-50 text-orange-700 text-xs font-bold border border-orange-100">
                    <CreditCard className="w-3 h-3" /> {giver.pushPayId}
                  </span>
                )}
                {!giver.eTransferId && !giver.eTransferId2 && !giver.pushPayId && (
                   <span className="text-xs text-gray-300 font-medium">No Digital IDs</span>
                )}
             </div>
          </div>
        ))}
      </div>

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl p-8 w-full max-w-2xl shadow-2xl overflow-y-auto max-h-[90vh]">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-2xl font-bold text-gray-800">{formData.id ? 'Edit Profile' : 'New Profile'}</h3>
              <div className="bg-blue-50 px-4 py-2 rounded-xl border border-blue-100">
                <span className="text-xs font-bold text-church-900 uppercase block">Envelope</span>
                <span className="text-2xl font-bold text-church-500">#{nextEnv}</span>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              
              {/* Names Section */}
              <div className="space-y-4">
                <h4 className="text-sm font-bold text-gray-400 uppercase tracking-wider border-b border-gray-100 pb-1">Identity</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Primary Name <span className="text-red-400">*</span></label>
                    <input 
                      required
                      placeholder="e.g. John Doe"
                      className="w-full p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
                      value={formData.name}
                      onChange={e => setFormData({...formData, name: e.target.value})}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Joint / Second Name</label>
                    <input 
                      placeholder="e.g. Jane Doe"
                      className="w-full p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
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
                      className="w-full p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
                      value={formData.email}
                      onChange={e => setFormData({...formData, email: e.target.value})}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Secondary Email</label>
                    <input 
                      type="email"
                      placeholder="spouse@email.com"
                      className="w-full p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
                      value={formData.email2}
                      onChange={e => setFormData({...formData, email2: e.target.value})}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">Mailing Address</label>
                  <input 
                    placeholder="Address Line 1"
                    className="w-full p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
                    value={formData.address1}
                    onChange={e => setFormData({...formData, address1: e.target.value})}
                  />
                  <input 
                    placeholder="Address Line 2 (Optional)"
                    className="w-full p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
                    value={formData.address2}
                    onChange={e => setFormData({...formData, address2: e.target.value})}
                  />
                  <input 
                    placeholder="Address Line 3 (City, State, Zip)"
                    className="w-full p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
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
                            className="w-full pl-10 p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
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
                            className="w-full pl-10 p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
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
                        className="w-full pl-10 p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-church-500 bg-gray-50 focus:bg-white transition-colors"
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