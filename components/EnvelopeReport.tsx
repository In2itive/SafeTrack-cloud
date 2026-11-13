import React, { useEffect, useState, useRef, forwardRef, useImperativeHandle } from 'react';
import { formatDate } from '../utils/date';
import { useParams, useNavigate } from 'react-router-dom';
import { useLive, getSettings, getBatch, listDonations, getGivers, shortId } from '../services/repo';
import { PaymentMethod, Giver, Donation } from '../types';
import { ArrowLeft, Printer, Users, Download, Mail } from 'lucide-react';
import html2pdf from 'html2pdf.js';
import { useAuth } from '../contexts/AuthContext';
import { sendEmailWithPDF } from '../services/email';

export interface ReportRef {
  sendEmail: () => Promise<void>;
}

interface EnvelopeReportProps {
  batchIdProp?: string;
  hiddenMode?: boolean;
}

const EnvelopeReport = forwardRef<ReportRef, EnvelopeReportProps>(({ batchIdProp, hiddenMode }, ref) => {
  const { batchId: routeBatchId } = useParams();
  const batchId = batchIdProp ? batchIdProp.toString() : routeBatchId;
  const navigate = useNavigate();
  const { user, secondaryUser } = useAuth();
  const [givers, setGivers] = useState<Map<string, Giver>>(new Map());
  const reportRef = useRef<HTMLDivElement>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [newGivers, setNewGivers] = useState<Giver[]>([]);

  const settings = useLive(getSettings);

  const batch = useLive(() => batchId ? getBatch(batchId) : Promise.resolve(undefined), [batchId]);

  const donations = useLive(() => batchId ? listDonations(batchId) : Promise.resolve([]), [batchId]);

  // Fetch Givers and New Givers
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

  useEffect(() => {
    if (batch && batch.newGiverIds && batch.newGiverIds.length > 0) {
      getGivers(batch.newGiverIds).then(giverList => {
        setNewGivers(giverList.filter((g): g is Giver => !!g));
      });
    } else {
      setNewGivers([]);
    }
  }, [batch]);

  const handleDownloadPDF = () => {
    if (!reportRef.current || !batch) return;
    setIsGenerating(true);

    const element = reportRef.current;
    const opt = {
      margin: 10,
      filename: `EnvelopeReport_Batch${shortId(batch.id)}_${new Date().toISOString().split('T')[0]}.pdf`,
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
    const filename = `EnvelopeReport_Batch${shortId(batch.id)}_${new Date().toISOString().split('T')[0]}.pdf`;
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
      const safeFilename = `Batch_${shortId(batch.id)}_Envelopes_${timestamp}.pdf`;
      
      await sendEmailWithPDF(pdfBlob, safeFilename, 'envelope');
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

  // --- Processing ---

  // 1. Group by Envelope (Regular Givers Only)
  const envelopeGroups = new Map<string, { giver: Giver, donations: Donation[] }>();
  const specialDonations: Donation[] = [];
  // #0 Loose Giving and #1 Internal are reported separately from envelopes
  // Givers registered during this batch get a NEW badge and their address for the steward
  const isNewGiver = (g: Giver) => !!g.id && !!batch.newGiverIds?.includes(g.id);
  const fullAddress = (g: Giver) => [g.address1, g.address2, g.address3].filter(Boolean).join(', ');
  const isSpecial = (id: string) => { const e = givers.get(id)?.envelopeNumber; return e === 0 || e === 1; };

  donations.forEach(d => {
    // Check if Loose (0) or Internal (-1)
    if (isSpecial(d.giverId)) {
      specialDonations.push(d);
    } else {
      const giver = givers.get(d.giverId) || { id: d.giverId, name: 'Unknown', envelopeNumber: 99999 };
      
      if (!envelopeGroups.has(d.giverId)) {
        envelopeGroups.set(d.giverId, { giver, donations: [] });
      }
      envelopeGroups.get(d.giverId)!.donations.push(d);
    }
  });

  const sortedEnvelopes = Array.from(envelopeGroups.values()).sort((a, b) => {
    return a.giver.envelopeNumber - b.giver.envelopeNumber;
  });

  // 2. Summaries
  const regularFundSummary: Record<string, number> = {};
  const specialFundSummary: Record<string, number> = {};

  // Process Regular Donations
  Array.from(envelopeGroups.values()).forEach(group => {
    group.donations.forEach(d => {
      d.splits.forEach(s => {
        const fundName = s.fund; // Regular donations usually don't have internal accounts, but if they did, we treat them as funds here
        regularFundSummary[fundName] = (regularFundSummary[fundName] || 0) + s.amount;
      });
    });
  });

  // Process Special Donations (Loose & Internal)
  specialDonations.forEach(d => {
    d.splits.forEach(s => {
      let fundName = s.fund;
      if (givers.get(d.giverId)?.envelopeNumber === 0) {
        fundName = `Loose: ${s.fund}`;
      } else if (givers.get(d.giverId)?.envelopeNumber === 1) {
         fundName = `Internal: ${s.internalAccount || s.fund}`;
      }
      specialFundSummary[fundName] = (specialFundSummary[fundName] || 0) + s.amount;
    });
  });

  const totalRegular = Object.values(regularFundSummary).reduce((a, b) => a + b, 0);
  const totalSpecial = Object.values(specialFundSummary).reduce((a, b) => a + b, 0);
  const grandTotal = totalRegular + totalSpecial;

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
        
        {/* Header */}
        <div className="border-b-2 border-gray-800 pb-6 mb-8 print:pb-4 print:mb-6">
          <div className="flex justify-between items-end">
            <div>
              {settings?.churchLogo && <img src={settings.churchLogo} alt="Church Logo" className="h-16 object-contain mb-4" />}
              <h1 className="text-3xl font-bold text-gray-900 uppercase tracking-wider mb-2 print:text-2xl">Envelope Steward's Report</h1>
              <div className="text-sm font-medium text-gray-600 print:text-xs">
                <p>Batch #: <span className="font-bold text-gray-900">{shortId(batch.id)}</span></p>
                <p>Date: <span className="font-bold text-gray-900">{formatDate(batch.date)}</span></p>
                <p>Source: <span className="font-bold text-gray-900">{batch.source}</span></p>
                <p>Tellers: <span className="font-bold text-gray-900">
                  {batch.finalizedBy?.join(', ') || 'Not Finalized'}{batch.adjustedBy?.length ? ` · Adj: ${batch.adjustedBy.join(', ')}` : ''}
                </span></p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-gray-500 uppercase text-xs font-bold mb-1">Batch Total</p>
              <p className="text-4xl font-black text-gray-900 print:text-3xl">${grandTotal.toFixed(2)}</p>
            </div>
          </div>
        </div>

        {/* Envelope List (Regular Givers Only) */}
        <div className="space-y-8 print:space-y-6">
          {sortedEnvelopes.map((group) => {
            const groupTotal = group.donations.reduce((sum, d) => sum + d.amount, 0);
            
            return (
              <div key={group.giver.id} className="break-inside-avoid">
                <div className="flex justify-between items-start bg-gray-50 p-2 rounded-t-lg border-b border-gray-200 print:bg-gray-100 print:py-1">
                  <div>
                    <h3 className="font-bold text-gray-800 flex items-center gap-2">
                      <span className="inline-block w-16 bg-white border border-gray-300 rounded px-2 py-0.5 text-center text-sm">#{group.giver.envelopeNumber}</span>
                      {group.giver.name} {group.giver.name2 ? `& ${group.giver.name2}` : ''}
                      {isNewGiver(group.giver) && <span className="text-[10px] bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded uppercase font-bold">New</span>}
                    </h3>
                    {isNewGiver(group.giver) && fullAddress(group.giver) && (
                      <p className="text-xs text-gray-600 mt-1 ml-[5.5rem]">{fullAddress(group.giver)}</p>
                    )}
                  </div>
                  <span className="font-bold text-gray-900">${groupTotal.toFixed(2)}</span>
                </div>
                
                <table className="w-full text-sm border-x border-b border-gray-100">
                  <thead className="text-xs text-gray-400 uppercase bg-white">
                    <tr>
                      <th className="py-1 pl-4 text-left font-medium w-1/3">Fund</th>
                      <th className="py-1 text-left font-medium w-1/4">Method</th>
                      <th className="py-1 text-left font-medium">Detail</th>
                      <th className="py-1 pr-4 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {group.donations.map(d => (
                      <React.Fragment key={d.id}>
                        {d.splits.map((split, idx) => (
                          <tr key={`${d.id}-${idx}`}>
                            <td className="py-1 pl-4 text-gray-700">
                              {split.fund === 'Internal' && split.internalAccount 
                                ? `Internal (${split.internalAccount})` 
                                : split.fund}
                            </td>
                            <td className="py-1 text-gray-500 text-xs">{d.paymentMethod}</td>
                            <td className="py-1 text-gray-500 text-xs font-mono">
                              {d.paymentMethod === PaymentMethod.Cheque ? `#${d.chequeNumber}` : '-'}
                            </td>
                            <td className="py-1 pr-4 text-right font-mono text-gray-600">${split.amount.toFixed(2)}</td>
                          </tr>
                        ))}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
          {sortedEnvelopes.length === 0 && (
            <p className="text-center text-gray-400 italic py-8">No envelope donations in this batch.</p>
          )}
        </div>

        {/* Batch Summary Footer */}
        <div className="mt-12 break-inside-avoid">
          <h3 className="text-lg font-bold text-gray-800 border-b-2 border-gray-800 pb-2 mb-4 uppercase tracking-wide">Batch Fund Summary</h3>
          <div className="grid grid-cols-2 gap-8">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="py-2 pl-2 text-left">Fund Designation</th>
                  <th className="py-2 pr-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {/* A) Regular Funds */}
                {Object.entries(regularFundSummary).length > 0 && (
                  <>
                    <tr className="bg-gray-50"><td colSpan={2} className="py-1 px-2 text-xs font-bold text-gray-400 uppercase tracking-wider">Envelope Giving</td></tr>
                    {Object.entries(regularFundSummary).sort().map(([fund, amount]) => (
                      <tr key={`reg-${fund}`}>
                        <td className="py-2 pl-4 text-gray-800 font-medium">{fund}</td>
                        <td className="py-2 pr-2 text-right font-mono font-bold">${amount.toFixed(2)}</td>
                      </tr>
                    ))}
                    <tr className="bg-gray-50 font-bold">
                      <td className="py-2 pl-2 text-gray-600 text-xs uppercase">Subtotal (Envelopes)</td>
                      <td className="py-2 pr-2 text-right text-gray-800">${totalRegular.toFixed(2)}</td>
                    </tr>
                  </>
                )}

                {/* B) Loose & Internal */}
                {Object.entries(specialFundSummary).length > 0 && (
                   <>
                    <tr className="bg-gray-50"><td colSpan={2} className="py-1 px-2 text-xs font-bold text-gray-400 uppercase tracking-wider mt-2">Loose & Internal</td></tr>
                    {Object.entries(specialFundSummary).sort().map(([fund, amount]) => (
                      <tr key={`spec-${fund}`}>
                        <td className="py-2 pl-4 text-gray-800 font-medium">{fund}</td>
                        <td className="py-2 pr-2 text-right font-mono font-bold">${amount.toFixed(2)}</td>
                      </tr>
                    ))}
                    <tr className="bg-gray-50 font-bold">
                      <td className="py-2 pl-2 text-gray-600 text-xs uppercase">Subtotal (Loose/Internal)</td>
                      <td className="py-2 pr-2 text-right text-gray-800">${totalSpecial.toFixed(2)}</td>
                    </tr>
                   </>
                )}

                {/* C) Grand Total */}
                <tr className="bg-gray-100 font-bold border-t-2 border-gray-300">
                  <td className="py-3 pl-2 text-gray-900 uppercase">Grand Total</td>
                  <td className="py-3 pr-2 text-right text-gray-900 text-lg">${grandTotal.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
            
            {/* Optional: Notes or Sign-off area */}
            <div className="border border-gray-200 rounded-xl p-4 text-xs text-gray-400 flex flex-col justify-between">
               <p className="uppercase font-bold mb-2">Steward's Notes:</p>
               <div className="border-b border-gray-200 h-8"></div>
               <div className="border-b border-gray-200 h-8"></div>
               <div className="border-b border-gray-200 h-8"></div>
               <div className="mt-8 pt-4 border-t border-gray-300">
                 <p>Steward Signature</p>
               </div>
            </div>
          </div>
        </div>

        {/* New Envelopes Section */}
        {newGivers.length > 0 && (
          <div className="mt-12 break-inside-avoid">
            <h3 className="text-lg font-bold text-gray-800 border-b-2 border-gray-800 pb-2 mb-4 uppercase tracking-wide">New Envelopes Created</h3>
            <div className="bg-blue-50/50 border border-blue-100 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-blue-100/50 text-blue-800 text-xs uppercase">
                  <tr>
                    <th className="py-2 pl-4 text-left font-bold">Env #</th>
                    <th className="py-2 text-left font-bold">Name</th>
                    <th className="py-2 pr-4 text-left font-bold">Address</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-blue-100/50">
                  {newGivers.map(giver => (
                    <tr key={giver.id}>
                      <td className="py-2 pl-4 font-mono font-bold text-gray-800">{giver.envelopeNumber}</td>
                      <td className="py-2 text-gray-800 font-medium">{giver.name} {giver.name2 ? `& ${giver.name2}` : ''}</td>
                      <td className="py-2 pr-4 text-gray-600">{giver.address1 || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500 mt-2 italic">Please ensure these new envelopes are entered into the tax receipt system.</p>
          </div>
        )}

        {/* Footer */}
        <div className="mt-8 pt-4 border-t border-gray-200 text-center text-xs text-gray-400 print:mt-4">
          {batch.finalizedBy && batch.finalizedBy.length > 0 && (
            <p className="mb-2 text-gray-600 font-medium">
              Finalized by: {batch.finalizedBy.join(', ')}{batch.adjustedBy?.length ? ` (adjusted by ${batch.adjustedBy.join(', ')})` : ''}
            </p>
          )}
          <p>SafeTrack Vault System • {new Date().toLocaleString()}</p>
        </div>

      </div>
    </div>
  );
});

export default EnvelopeReport;
