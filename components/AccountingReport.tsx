import React, { useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../services/db';
import { ArrowLeft, Printer, FileSpreadsheet, Download, Mail } from 'lucide-react';
import html2pdf from 'html2pdf.js';
import { useAuth } from '../contexts/AuthContext';
import { sendEmailWithPDF } from '../services/email';

export interface ReportRef {
  sendEmail: () => Promise<void>;
}

interface AccountingReportProps {
  batchIdProp?: number;
  hiddenMode?: boolean;
}

const AccountingReport = forwardRef<ReportRef, AccountingReportProps>(({ batchIdProp, hiddenMode }, ref) => {
  const { batchId: routeBatchId } = useParams();
  const batchId = batchIdProp ? batchIdProp.toString() : routeBatchId;
  const navigate = useNavigate();
  const { user, secondaryUser } = useAuth();
  const reportRef = useRef<HTMLDivElement>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const settings = useLiveQuery(() => db.settings.orderBy('id').first());

  const batch = useLiveQuery(() => 
    batchId ? db.batches.get(parseInt(batchId)) : Promise.resolve(undefined)
  , [batchId]);

  const donations = useLiveQuery(() => 
    batchId ? db.donations.where('batchId').equals(parseInt(batchId)).toArray() : Promise.resolve([])
  , [batchId]);

  const handleDownloadPDF = () => {
    if (!reportRef.current || !batch) return;
    setIsGenerating(true);

    const element = reportRef.current;
    const opt = {
      margin: 10,
      filename: `AccountingReport_Batch${batch.id}_${new Date().toISOString().split('T')[0]}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    html2pdf().set(opt).from(element).save().then(() => {
      setIsGenerating(false);
    });
  };

  const handleShare = async () => {
    if (!reportRef.current || !batch) return;
    setIsGenerating(true);

    const element = reportRef.current;
    const filename = `AccountingReport_Batch${batch.id}_${new Date().toISOString().split('T')[0]}.pdf`;
    const opt = {
      margin: 10,
      filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    try {
      const pdfBlob = await html2pdf().set(opt).from(element).output('blob');
      const safeFilename = `Batch_${batch.id}_Accounting.pdf`;
      
      await sendEmailWithPDF(pdfBlob, safeFilename, 'accounting');
      if (!hiddenMode) alert('Email sent successfully!');
    } catch (err: any) {
      console.error("Error sending email:", err);
      if (!hiddenMode) alert(err.message || "There was an error sending the email.");
      throw err;
    } finally {
      setIsGenerating(false);
    }
  };

  useImperativeHandle(ref, () => ({
    sendEmail: handleShare
  }));

  if (!batch || !donations) return <div className="p-8 text-center">Loading report...</div>;

  // --- Calculations ---
  const fundTotals: Record<string, number> = {};
  const internalTotals: Record<string, number> = {};

  donations.forEach(d => {
    d.splits.forEach(split => {
      if (split.fund === 'Internal') {
        const account = split.internalAccount || 'Unspecified';
        internalTotals[account] = (internalTotals[account] || 0) + split.amount;
      } else {
        fundTotals[split.fund] = (fundTotals[split.fund] || 0) + split.amount;
      }
    });
  });

  const totalFunds = Object.values(fundTotals).reduce((a, b) => a + b, 0);
  const totalInternal = Object.values(internalTotals).reduce((a, b) => a + b, 0);
  const grandTotal = totalFunds + totalInternal;

  return (
    <div className={hiddenMode ? "" : "min-h-screen bg-gray-100 p-8 print:p-0 print:bg-white"}>
      {/* No-Print Header */}
      {!hiddenMode && (
        <div className="max-w-4xl mx-auto mb-8 flex justify-between items-center print:hidden">
          <button 
            onClick={() => navigate('/history')}
            className="flex items-center gap-2 text-gray-600 hover:text-gray-900 font-bold"
          >
            <ArrowLeft className="w-5 h-5" /> Back to History
          </button>
          <div className="flex gap-3">
            <button 
              onClick={handleShare}
              disabled={isGenerating}
              className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 hover:bg-green-700 transition-colors disabled:opacity-50"
            >
              <Mail className="w-4 h-4" />
              {isGenerating ? 'Sending...' : 'Email Report'}
            </button>
            <button 
              onClick={handleDownloadPDF}
              disabled={isGenerating}
              className="bg-church-900 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 hover:bg-church-800 transition-colors disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              {isGenerating ? 'Generating...' : 'Download PDF'}
            </button>
            <button 
              onClick={() => window.print()}
              className="bg-blue-50 text-blue-800 px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 hover:bg-blue-100 transition-colors"
            >
              <Printer className="w-4 h-4" />
              Print
            </button>
          </div>
        </div>
      )}

      {/* Report Paper */}
      <div ref={reportRef} className="max-w-4xl mx-auto bg-white p-12 rounded-3xl shadow-xl print:shadow-none print:p-8 print:max-w-none">
        
        {/* Header */}
        <div className="border-b-2 border-gray-800 pb-6 mb-8 print:pb-4 print:mb-6">
          <div className="flex justify-between items-end">
            <div>
              {settings?.churchLogo && <img src={settings.churchLogo} alt="Church Logo" className="h-16 object-contain mb-4" />}
              <h1 className="text-3xl font-bold text-gray-900 uppercase tracking-wider mb-2 print:text-2xl">Accounting Summary</h1>
              <div className="text-sm font-medium text-gray-600 print:text-xs">
                <p>Batch #: <span className="font-bold text-gray-900">{batch.id}</span></p>
                <p>Date: <span className="font-bold text-gray-900">{new Date(batch.date).toLocaleDateString()}</span></p>
                <p>Source: <span className="font-bold text-gray-900">{batch.source}</span></p>
                <p>Tellers: <span className="font-bold text-gray-900">
                  {batch.finalizedBy?.join(', ') || 'Not Finalized'}
                </span></p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-gray-500 uppercase text-xs font-bold mb-1">Batch Total</p>
              <p className="text-4xl font-black text-gray-900 print:text-3xl">${grandTotal.toFixed(2)}</p>
            </div>
          </div>
        </div>

        {/* Content Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 print:gap-8">
          
          {/* Fund Totals */}
          <div>
            <h3 className="text-lg font-bold text-gray-800 border-b border-gray-200 pb-2 mb-4 flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-church-500" />
              Fund Distribution
            </h3>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="py-2 pl-2 text-left">Fund Name</th>
                  <th className="py-2 pr-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {Object.entries(fundTotals).sort().map(([fund, amount]) => (
                  <tr key={fund}>
                    <td className="py-3 pl-2 text-gray-800 font-medium">{fund}</td>
                    <td className="py-3 pr-2 text-right font-mono font-bold">${amount.toFixed(2)}</td>
                  </tr>
                ))}
                {Object.keys(fundTotals).length === 0 && (
                  <tr><td colSpan={2} className="py-4 text-center text-gray-400 italic">No fund allocations.</td></tr>
                )}
                <tr className="bg-gray-50 font-bold border-t-2 border-gray-200">
                  <td className="py-3 pl-2 text-gray-900">Total Funds</td>
                  <td className="py-3 pr-2 text-right text-gray-900">${totalFunds.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Internal Accounts */}
          <div>
            <h3 className="text-lg font-bold text-gray-800 border-b border-gray-200 pb-2 mb-4 flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-church-500" />
              Internal Accounts
            </h3>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="py-2 pl-2 text-left">Account #</th>
                  <th className="py-2 pr-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {Object.entries(internalTotals).sort().map(([account, amount]) => (
                  <tr key={account}>
                    <td className="py-3 pl-2 text-gray-800 font-medium">{account}</td>
                    <td className="py-3 pr-2 text-right font-mono font-bold">${amount.toFixed(2)}</td>
                  </tr>
                ))}
                {Object.keys(internalTotals).length === 0 && (
                  <tr><td colSpan={2} className="py-4 text-center text-gray-400 italic">No internal accounts.</td></tr>
                )}
                <tr className="bg-gray-50 font-bold border-t-2 border-gray-200">
                  <td className="py-3 pl-2 text-gray-900">Total Internal</td>
                  <td className="py-3 pr-2 text-right text-gray-900">${totalInternal.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
          </div>

        </div>

        {/* Footer */}
        <div className="mt-12 pt-8 border-t border-gray-200 text-center text-xs text-gray-400 print:mt-8">
          {batch.finalizedBy && batch.finalizedBy.length > 0 && (
            <p className="mb-2 text-gray-600 font-medium">
              Finalized by: {batch.finalizedBy.join(', ')}
            </p>
          )}
          <p>Generated by SafeTrack Vault System on {new Date().toLocaleString()}</p>
        </div>

      </div>
    </div>
  );
});

export default AccountingReport;
