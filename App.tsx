import React from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import GiverRegistry from './components/GiverRegistry';
import BatchEntry from './components/BatchEntry';
import BatchHistory from './components/BatchHistory';
import Settings from './components/Settings';
import DepositSlip from './components/DepositSlip';
import AccountingReport from './components/AccountingReport';
import EnvelopeReport from './components/EnvelopeReport';
import UserManagement from './components/UserManagement';
import GivingImport from './components/GivingImport';
import Login from './components/Login';
import InitialSetup from './components/InitialSetup';
import { AuthProvider, useAuth } from './contexts/AuthContext';

const AppContent: React.FC = () => {
  const { user, isAuthenticated, isLoading, needsChurch } = useAuth();
  const [creatingChurch, setCreatingChurch] = React.useState(false);

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-gray-100 text-gray-500">Loading Vault...</div>;
  }

  if (needsChurch || (creatingChurch && !user)) {
    return <InitialSetup onBack={() => setCreatingChurch(false)} />;
  }

  if (!isAuthenticated) {
    return <Login onCreateChurch={() => setCreatingChurch(true)} />;
  }

  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="givers" element={<GiverRegistry />} />
          <Route path="batch-entry" element={<BatchEntry />} />
          <Route path="history" element={<BatchHistory />} />
          <Route path="online-giving" element={<GivingImport />} />
          <Route path="settings" element={<Settings />} />
          <Route path="admin/users" element={<UserManagement />} />
        </Route>
        <Route path="/reports/deposit-slip/:batchId" element={<DepositSlip />} />
        <Route path="/reports/accounting/:batchId" element={<AccountingReport />} />
        <Route path="/reports/envelope/:batchId" element={<EnvelopeReport />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
};

const App: React.FC = () => {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
};

export default App;
