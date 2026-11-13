import React, { useEffect, useState, useRef, forwardRef, useImperativeHandle } from 'react';
import { formatDate } from '../utils/date';
import { useParams, useNavigate } from 'react-router-dom';
import { useLive, getSettings, getBatch, listDonations, getGivers, batchLabel } from '../services/repo';
import { PaymentMethod, Giver } from '../types';
import { Printer, ArrowLeft, Download, Mail } from 'lucide-react';
import html2pdf from 'html2pdf.js';
import { useAuth } from '../contexts/AuthContext';
import { sendEmailWithPDF } from '../services/email';

export interface ReportRef {
  sendEmail: () => Promise<void>;
}

interface DepositSlipProps {
  batchIdProp?: string;
  hiddenMode?: boolean;
}

const DepositSlip = forwardRef<ReportRef, DepositSlipProps>(({ batchIdProp, hiddenMode }, ref) => {
  const { batchId: routeBatchId } = useParams();
  const batchId = batchIdProp ? batchIdProp.toString() : routeBatchId;
  const navigate = useNavigate();
  const { user, secondaryUser } = useAuth();
  const [givers, setGivers] = useState<Map<string, Giver>>(new Map());
  const reportRef = useRef<HTMLDivElement>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const settings = useLive(getSettings);

  const batch = useLive(() => batchId ? getBatch(batchId) : Promise.resolve(undefined), [batchId]);

  const donations = useLive(() => batchId ? listDonations(batchId) : Promise.resolve([]), [batchId]);

  // Fetch Givers for names
  useEffect(() => {
    if (donations && donations.length > 0) {
      const giverIds = [...new Set(donations.map(d => d.giverId))];
      getGivers(giverIds).then(giverList => {
        const map = new Map<string, Giver>();
        giverList.forEach(g => {
          if (g) map.set(g.id!, g);
        });
        setGivers(map);
      });
    }
  }, [donations]);

  const handleDownloadPDF = () => {
    if (!reportRef.current || !batch) return;
    setIsGenerating(true);

    const element = reportRef.current;
    const opt = {
      margin: 10,
      filename: `DepositSlip_Batch${batchLabel(batch)}_${new Date().toISOString().split('T')[0]}.pdf`,
      image: { type: 'jpeg' as const, quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' as const }
    };

    html2pdf().set(opt).from(element).save().then(() => {
      setIsGenerating(false);
    });
  };

  const handleShare = async () => {
    if (!reportRef.current || !batch) return;
    setIsGenerating(true);

    const element = reportRef.current;
    const filename = `DepositSlip_Batch${batchLabel(batch)}_${new Date().toISOString().split('T')[0]}.pdf`;
    const opt = {
      margin: 10,
      filename,
      image: { type: 'jpeg' as const, quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' as const }
    };

    try {
      const pdfBlob = await html2pdf().set(opt).from(element).output('blob');
      const timestamp = new Date().getTime();
      const safeFilename = `Batch_${batchLabel(batch)}_Deposit_${timestamp}.pdf`;
      
      await sendEmailWithPDF(pdfBlob, safeFilename, 'deposit');
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

  // Cash Breakdown
  const DENOMINATIONS = [100, 50, 20, 10, 5, 2, 1, 0.25, 0.10, 0.05];
  const cashCounts: Record<string, number> = {};
  DENOMINATIONS.forEach(d => cashCounts[d.toString()] = 0);

  donations.filter(d => d.paymentMethod === PaymentMethod.Cash).forEach(d => {
    if (d.cashCounts) {
      Object.entries(d.cashCounts).forEach(([denom, count]) => {
        cashCounts[denom] = (cashCounts[denom] || 0) + (count as number);
      });
    }
  });

  const totalCash = donations
    .filter(d => d.paymentMethod === PaymentMethod.Cash)
    .reduce((sum, d) => sum + d.amount, 0);

  // Cheque List
  const checks = donations
    .filter(d => d.paymentMethod === PaymentMethod.Cheque)
    .map(d => {
      const giver = givers.get(d.giverId);
      return {
        chequeNumber: d.chequeNumber,
        name: giver ? (giver.name2 ? `${giver.name} & ${giver.name2}` : giver.name) : 'Unknown',
        amount: d.amount
      };
    });

  const totalChecks = checks.reduce((sum, c) => sum + c.amount, 0);
  const grandTotal = totalCash + totalChecks;

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
      <div ref={reportRef} className="max-w-4xl mx-auto bg-white p-6 rounded-3xl shadow-xl print:shadow-none print:p-0 print:max-w-none">
        
        {/* Header Section - Reorganized for Print Compactness */}
        <div className="flex justify-between items-start border-b-2 border-gray-800 pb-6 mb-8 print:pb-4 print:mb-6">
          {/* Bank Info */}
          <div className="flex flex-col w-1/2 pr-4">
            {settings?.bankLogo && <img src={settings.bankLogo} alt="Bank Logo" className="h-16 object-contain mb-2 self-start" />}
            <div className="text-xl font-bold uppercase tracking-wider text-gray-800 mb-2">Deposit Slip</div>
            <div className="text-sm text-gray-700">
              <p><span className="font-bold">Account Of:</span> {settings?.accountOf || '________________________'}</p>
              <p><span className="font-bold">Branch #:</span> {settings?.branchNumber || '________'}</p>
              <p><span className="font-bold">Account #:</span> {settings?.accountNumber || '________________'}</p>
            </div>
          </div>
          {/* Church Info */}
          <div className="flex flex-col w-1/2 pl-4 items-end text-right">
            {settings?.churchLogo && <img src={settings.churchLogo} alt="Church Logo" className="h-16 object-contain mb-2 self-end" />}
            <div className="text-sm text-gray-700">
              <p>{settings?.churchAddressLine1 || '________________________'}</p>
              <p>{settings?.churchAddressLine2 || '________________________'}</p>
              <p>{settings?.churchAddressLine3 || '________________________'}</p>
            </div>
            <div className="mt-4 text-sm">
              <p>Date: <span className="font-bold">{formatDate(batch.date)}</span></p>
              <p>Batch #: <span className="font-bold">{batchLabel(batch)}</span></p>
            </div>
          </div>
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-12 print:block">
          
          {/* Cash Breakdown (Sidebar on Screen, Top-Inline on Print) */}
          <div className="md:col-span-4 print:mb-4 print:border-b print:border-gray-200 print:pb-2">
            <h3 className="text-lg font-bold text-gray-800 border-b border-gray-200 pb-2 mb-4 flex justify-between items-center print:text-sm print:mb-2 print:border-none">
              <span>Cash Breakdown</span>
              <span className="text-sm font-normal text-gray-500 print:hidden">Count x Denom</span>
            </h3>
            
            {/* Print-Optimized Cash Grid */}
            <div className="hidden print:grid print:grid-cols-5 print:gap-x-4 print:gap-y-1 print:text-[10px]">
               {DENOMINATIONS.map(denom => {
                  const count = cashCounts[denom.toString()] || 0;
                  if (count === 0) return null;
                  return (
                    <div key={denom} className="flex justify-between border-b border-gray-100">
                      <span className="font-mono">${denom}</span>
                      <span className="font-bold">x{count}</span>
                    </div>
                  );
               })}
            </div>

            {/* Screen Table */}
            <table className="w-full text-sm print:hidden">
              <tbody>
                {DENOMINATIONS.map(denom => {
                  const count = cashCounts[denom.toString()] || 0;
                  if (count === 0) return null;
                  const total = count * denom;
                  return (
                    <tr key={denom} className="border-b border-gray-100 last:border-0">
                      <td className="py-2 text-gray-600 font-mono">${denom.toFixed(2)}</td>
                      <td className="py-2 text-center font-bold text-gray-800">x {count}</td>
                      <td className="py-2 text-right font-mono font-medium">${total.toFixed(2)}</td>
                    </tr>
                  );
                })}
                {totalCash === 0 && (
                  <tr><td colSpan={3} className="py-4 text-center text-gray-400 italic">No cash in this batch.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Cheque List (Main Content) */}
          <div className="md:col-span-8">
            <h3 className="text-lg font-bold text-gray-800 border-b border-gray-200 pb-2 mb-4 flex justify-between items-center print:text-sm print:mb-2">
              <span>Cheque List</span>
              <span className="text-sm font-bold text-gray-800">{checks.length} Cheques</span>
            </h3>

            <div className="overflow-hidden">
              <table className="w-full text-sm print:text-xs">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase print:bg-transparent print:border-b print:border-gray-300">
                  <tr>
                    <th className="py-2 pl-2 text-left print:py-1">Chq #</th>
                    <th className="py-2 text-left print:py-1">Name</th>
                    <th className="py-2 pr-2 text-right print:py-1">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 print:divide-gray-200">
                  {checks.map((c, i) => (
                    <tr key={i} className="break-inside-avoid">
                      <td className="py-2 pl-2 font-mono text-gray-600 print:py-0.5">{c.chequeNumber || '-'}</td>
                      <td className="py-2 text-gray-800 truncate max-w-[120px] print:max-w-none print:py-0.5">{c.name}</td>
                      <td className="py-2 pr-2 text-right font-mono font-medium print:py-0.5">${c.amount.toFixed(2)}</td>
                    </tr>
                  ))}
                  {checks.length === 0 && (
                    <tr><td colSpan={3} className="py-4 text-center text-gray-400 italic">No cheques in this batch.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Totals Section (Moved to bottom) */}
        <div className="mt-8 pt-6 border-t-2 border-gray-800 break-inside-avoid print:mt-4 print:pt-4">
          <div className="flex justify-end gap-12 text-sm print:text-xs">
            <div className="text-right">
               <p className="text-gray-500 uppercase text-xs font-bold">Total Cash</p>
               <p className="text-xl font-bold text-gray-900 print:text-lg">${totalCash.toFixed(2)}</p>
            </div>
            <div className="text-right">
               <p className="text-gray-500 uppercase text-xs font-bold">Total Cheques (<span className="font-black text-gray-900">{checks.length}</span>)</p>
               <p className="text-xl font-bold text-gray-900 print:text-lg">${totalChecks.toFixed(2)}</p>
            </div>
            <div className="pl-12 border-l border-gray-300 text-right print:pl-8">
               <p className="text-gray-500 uppercase text-xs font-bold">Deposit Total</p>
               <p className="text-2xl font-black text-gray-900 print:text-xl">${grandTotal.toFixed(2)}</p>
            </div>
          </div>
        </div>

        {/* Signature Line: the original two tellers always stay on the slip; an admin adjustment adds a line */}
        <div className={`mt-16 pt-8 border-t border-gray-300 grid ${batch.adjustedBy?.length ? 'grid-cols-4' : 'grid-cols-3'} gap-12 text-xs text-gray-400 uppercase tracking-widest break-inside-avoid print:mt-8 print:pt-4`}>
          {[0, 1].map(i => (
            <div key={i} className="space-y-12 print:space-y-8">
              <div>
                <div className="border-b border-gray-400 mb-2 h-6 flex items-end">
                  <span className="text-gray-800 font-bold text-sm normal-case">{batch.finalizedBy?.[i] || ''}</span>
                </div>
                Teller {i + 1} Secure Sign in
              </div>
            </div>
          ))}

          {batch.adjustedBy?.length ? (
            <div className="space-y-12 print:space-y-8">
              <div>
                <div className="border-b border-gray-400 mb-2 h-6 flex items-end">
                  <span className="text-gray-800 font-bold text-sm normal-case">{batch.adjustedBy.join(', ')}</span>
                </div>
                Admin / Adj
              </div>
            </div>
          ) : null}

          <div className="flex flex-col justify-end pb-1">
            <div className="border-b border-gray-400 mb-2 h-6 flex items-end justify-end">
              {batch.status === 'Finalized' && <span className="text-gray-800 font-bold text-sm normal-case">{new Date().toLocaleDateString()}</span>}
            </div>
            <div className="text-right">Date</div>
          </div>
        </div>

      </div>
    </div>
  );
});

export default DepositSlip;
