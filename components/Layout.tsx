import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

const Layout: React.FC = () => {
  return (
    <div className="flex h-screen overflow-hidden bg-gray-100 font-sans">
      <Sidebar />
      <main className="ml-64 flex-1 p-4 overflow-y-auto relative" id="main-scroll-container">
        <div className="max-w-7xl w-full mx-auto min-h-full h-full relative flex flex-col layout-outlet-container">
          <Outlet />
        </div>
      </main>
    </div>
  );
};

export default Layout;