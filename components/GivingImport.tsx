import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle2, CreditCard, Eye, EyeOff, Send, SlidersHorizontal,
  Upload, UserPlus, X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { addGiver, listFunds, listGivers, useLive } from '../services/repo';
import { formatDate } from '../utils/date';
import { UserRole, type Giver } from '../types';
import { PROVIDERS } from '../services/giving/providers';
import { parseCsv } from '../services/giving/parse';
import {
  buildIndexes, fundKeyOf, hasPayerIdentity, payerLabel, suggestFund, suggestGiver, type FundReason, type GiverReason, type MatchContext,
} from '../services/giving/matching';
import {
  listFundMap, listGiverLinks, listQueue, postGifts, setIgnored, stageGifts,
} from '../services/giving/repo';
import type {
  ColumnMapping, CsvTable, DateOrder, DocumentProvider, FileProvider, ParseResult, ProviderId, SourceDoc, StagedGift,
} from '../services/giving/types';

const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const METHOD_LABEL: Record<string, string> = { card: 'Card', bank_debit: 'Bank debit', online: 'Online', e_transfer: 'e-Transfer' };

const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

/** Monday of the gift's week, as YYYY-MM-DD. */
const weekStart = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

type Note = { kind: 'ok' | 'warn' | 'error'; text: React.ReactNode } | null;

interface Row extends StagedGift {
  giverIdEff?: string;
  giverReason?: GiverReason | 'chosen';
  candidates?: string[];
  fundIdEff?: string;
  fundReason?: FundReason | 'chosen';
  ready: boolean;
}

/** Green = reliable match; amber = check it (a guess, or a giver matched on name only). */
const ReasonBadge: React.FC<{ reason?: string; weak?: boolean }> = ({ reason, weak }) => {
  if (!reason) return null;
  const style = weak
    ? 'bg-amber-50 text-amber-700 border-amber-200'
    : 'bg-green-50 text-green-700 border-green-200';
  return <span className={`ml-1 px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide ${style}`}>{reason}</span>;
};

const GivingImport: React.FC = () => {
  const { user } = useAuth();
  const canManage = user?.role === UserRole.Administrator || user?.role === UserRole.Treasurer;
  const [providerId, setProviderIdRaw] = useState<ProviderId>(PROVIDERS[0].id);
  const provider = PROVIDERS.find(p => p.id === providerId)!;

  // ---- upload state ----
  const [fileName, setFileName] = useState('');
  const [table, setTable] = useState<CsvTable | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [dateOrder, setDateOrder] = useState<DateOrder>('auto');
  const [showMapping, setShowMapping] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const [docParsed, setDocParsed] = useState<ParseResult | null>(null);
  const [pasteText, setPasteText] = useState('');

  // ---- review state ----
  const [giverChoice, setGiverChoice] = useState<Record<string, string>>({});
  const [fundChoice, setFundChoice] = useState<Record<string, string>>({});
  const [rowFundChoice, setRowFundChoice] = useState<Record<string, string>>({});
  const [groupBy, setGroupBy] = useState<'auto' | 'date' | 'week' | 'deposit'>('auto');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showIgnored, setShowIgnored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  const queue = useLive(() => listQueue(providerId), [providerId]);
  const givers = useLive(listGivers, []);
  const funds = useLive(async () => (await listFunds()).filter(f => f.isActive), []);
  const giverLinks = useLive(() => listGiverLinks(providerId), [providerId]);
  const fundMap = useLive(() => listFundMap(providerId), [providerId]);

  const fp: FileProvider | null = provider.kind === 'file' ? provider : null;
  const dp: DocumentProvider | null = provider.kind === 'documents' ? provider : null;
  const missing = fp && table ? fp.missingFields(mapping) : [];
  const tableParsed: ParseResult | null = useMemo(() => {
    if (!fp || !table || missing.length) return null;
    return fp.parse(table, mapping, { dateOrder });
  }, [fp, table, mapping, dateOrder, missing.length]);
  const parsed = fp ? tableParsed : docParsed;

  const setProviderId = (id: ProviderId) => {
    setProviderIdRaw(id);
    setTable(null); setFileName(''); setMapping({}); setDocParsed(null); setPasteText('');
    setGiverChoice({}); setFundChoice({}); setRowFundChoice({}); setSelected(new Set()); setGroupBy('auto'); setNote(null);
  };

  // ---- matching ----
  const ctx: MatchContext | null = givers && funds && giverLinks && fundMap
    ? { givers, funds, giverLinks, fundMap } : null;
  const giverById = useMemo(() => new Map((givers ?? []).map(g => [g.id!, g])), [givers]);
  const giverOptions = useMemo(
    () => [...(givers ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [givers]);

  const rows: Row[] = useMemo(() => {
    if (!queue || !ctx) return [];
    const idx = buildIndexes(ctx);
    return queue.map(g => {
      const sg = suggestGiver(g, ctx, idx);
      const sf = suggestFund(g, ctx);
      const chosen = giverChoice[g.id];
      const giverIdEff = chosen || g.giverId || sg.giverId;
      const key = fundKeyOf(g);
      const fundIdEff = (key ? fundChoice[key] : rowFundChoice[g.id]) || g.fundId || sf.fundId;
      return {
        ...g, giverIdEff, fundIdEff, fundReason: (key ? fundChoice[key] : rowFundChoice[g.id]) ? 'chosen' : sf.reason, candidates: sg.candidates,
        giverReason: chosen ? 'chosen' : g.giverId ? 'remembered' : sg.reason,
        ready: !g.ignored && g.status === 'succeeded' && !!giverIdEff && !!fundIdEff,
      };
    });
  }, [queue, ctx, giverChoice, fundChoice, rowFundChoice]);

  const active = rows.filter(r => !r.ignored);
  const ignoredRows = rows.filter(r => r.ignored);
  const hasDeposits = active.some(r => r.depositRef);
  const by = groupBy === 'auto' ? (provider.defaultGrouping ?? (hasDeposits ? 'deposit' : 'date')) : groupBy;

  const groups = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of active) {
      const k = by === 'deposit' && r.depositRef ? `dep:${r.depositRef}`
              : by === 'week' ? `week:${weekStart(r.giftDate)}` : `date:${r.giftDate}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return [...m.entries()].map(([key, items]) => {
      const dates = items.map(i => i.giftDate).sort();
      const ready = items.filter(i => i.ready);
      return {
        key, items, ready,
        label: key.startsWith('dep:') ? `Deposit ${key.slice(4)}`
             : key.startsWith('week:') ? `Week ending ${formatDate(addDays(key.slice(5), 6))}` : formatDate(key.slice(5)),
        dateRange: dates[0] === dates[dates.length - 1] ? formatDate(dates[0]) : `${formatDate(dates[0])} – ${formatDate(dates[dates.length - 1])}`,
        batchDate: dates[dates.length - 1],
        gross: ready.reduce((s, i) => s + i.amount, 0),
        fees: ready.reduce((s, i) => s + i.fee, 0),
        unresolved: items.filter(i => i.status === 'succeeded' && !i.ready).length,
        pending: items.filter(i => i.status !== 'succeeded').length,
      };
    }).sort((a, b) => a.batchDate.localeCompare(b.batchDate));
  }, [active, by]);

  const fundRows = useMemo(() => {
    const m = new Map<string, { key: string; label: string; count: number; total: number; fundId?: string; reason?: FundReason | 'chosen' }>();
    if (!ctx) return [];
    for (const r of active) {
      const key = fundKeyOf(r);
      if (!key) continue;   // no fund field: chosen per gift in the table
      const label = r.fundName && r.fundKey && r.fundName !== r.fundKey ? `${r.fundName} (${r.fundKey})` : (r.fundName || r.fundKey || 'No fund given');
      const e = m.get(key) ?? { key, label, count: 0, total: 0 };
      e.count++; e.total += r.amount;
      const sf = suggestFund(r, ctx);
      e.fundId = fundChoice[key] || r.fundId || sf.fundId;
      e.reason = fundChoice[key] ? 'chosen' : sf.reason;
      m.set(key, e);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [active, ctx, fundChoice]);

  // Payers we could add as new givers (they have a name or email to go on)
  const unmatchedPayers = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of active) {
      if (r.giverIdEff || r.status !== 'succeeded' || r.candidates?.length || !hasPayerIdentity(r)) continue;
      const k = r.payerExternalId || r.payerEmail || payerLabel(r).toLowerCase();
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return m;
  }, [active]);

  // ---- actions ----
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setNote(null);
    try { await fn(); } catch (e) { setNote({ kind: 'error', text: (e as Error).message }); }
    finally { setBusy(false); }
  };

  const onFile = async (file: File) => {
    if (!fp) return;
    setNote(null);
    try {
      const t = parseCsv(await file.text());
      const m = fp.detectMapping(t.headers);
      setFileName(file.name); setTable(t); setMapping(m); setDateOrder('auto');
      setShowMapping(fp.missingFields(m).length > 0); setShowSkipped(false);
    } catch (e) {
      setNote({ kind: 'error', text: `Could not read ${file.name}: ${(e as Error).message}` });
    }
  };

  const clearUpload = () => { setTable(null); setFileName(''); setMapping({}); setDocParsed(null); setPasteText(''); };

  const onDocs = (files: File[] | null, pasted?: string) => run(async () => {
    if (!dp) return;
    const docs: SourceDoc[] = await Promise.all((files ?? []).map(async f => ({ name: f.name, content: await f.arrayBuffer(), lastModified: f.lastModified })));
    if (pasted?.trim()) docs.push({ name: 'Pasted text', content: pasted });
    if (!docs.length) return;
    setDocParsed(await dp.parseDocuments(docs));
    setFileName(docs.length === 1 ? docs[0].name : `${docs.length} files`);
    setShowSkipped(false);
  });

  const stage = () => run(async () => {
    if (!parsed) return;
    const r = await stageGifts(providerId, parsed.gifts);
    clearUpload();
    setNote({
      kind: r.refunded_after_post ? 'warn' : 'ok',
      text: <>
        {r.inserted} new gift{r.inserted === 1 ? '' : 's'} added for review
        {r.updated ? `, ${r.updated} updated` : ''}
        {r.already_posted ? `, ${r.already_posted} already posted (skipped)` : ''}.
        {r.refunded_after_post > 0 && <> <b>{r.refunded_after_post} gift(s) already posted have since been refunded in {provider.label}</b> — adjust those batches.</>}
      </>,
    });
  });

  const createGiver = async (rs: Row[]): Promise<Giver> => {
    const r = rs[0];
    const g = await addGiver({
      name: payerLabel(r), email: r.payerEmail, pushPayId: providerId === 'pushpay' ? r.payerExternalId : undefined,
      eTransferId: providerId === 'e_transfer' ? r.payerEmail : undefined,
      address1: r.payerAddress,
      // Keep the provider's envelope number when it's free and not reserved
      ...(r.payerEnvelope !== undefined && r.payerEnvelope >= 2 && !(givers ?? []).some(x => x.envelopeNumber === r.payerEnvelope)
        ? { envelopeNumber: r.payerEnvelope } : {}),
    } as Omit<Giver, 'id'>);
    setGiverChoice(c => ({ ...c, ...Object.fromEntries(rs.map(x => [x.id, g.id!])) }));
    return g;
  };

  const createAllUnmatched = () => run(async () => {
    let n = 0;
    for (const rs of unmatchedPayers.values()) { await createGiver(rs); n++; }
    setNote({ kind: 'ok', text: `${n} giver${n === 1 ? '' : 's'} added to the registry with new envelope numbers.` });
  });

  const postSelected = () => run(async () => {
    const todo = groups.filter(g => selected.has(g.key) && g.ready.length > 0);
    const done: string[] = [];
    try {
      for (const g of todo) {
        const res = await postGifts(
          providerId, g.ready.map(r => r.id),
          g.ready.map(r => ({ id: r.id, giver_id: r.giverIdEff!, fund_id: r.fundIdEff! })),
          g.batchDate);
        done.push(`#${res.batch_number} (${res.count} gifts, ${money(Number(res.total))})`);
      }
    } finally {
      if (done.length) {
        setSelected(new Set());
        setNote({ kind: 'ok', text: <>Created batch{done.length > 1 ? 'es' : ''} {done.join(', ')}. They still need two-person sign-off in <Link to="/history" className="underline font-semibold">Batch History</Link>.</> });
      }
    }
  });

  const toggleGroup = (k: string) => setSelected(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const selectedReady = groups.filter(g => selected.has(g.key)).reduce((s, g) => s + g.ready.length, 0);
  const selectedBatches = groups.filter(g => selected.has(g.key) && g.ready.length > 0).length;

  // ---- render ----
  return (
    <div className="space-y-6 pb-24">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2"><CreditCard className="w-6 h-6 text-church-500" /> Online Giving</h2>
          <p className="text-gray-500 text-sm">Bring online gifts in as batches. They are signed off by two people like any other batch.</p>
        </div>
        {PROVIDERS.length > 1 && (
          <div className="flex gap-1 bg-gray-100 p-1 rounded-xl">
            {PROVIDERS.map(p => (
              <button key={p.id} onClick={() => setProviderId(p.id)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium ${p.id === providerId ? 'bg-white shadow text-church-800' : 'text-gray-500'}`}>{p.label}</button>
            ))}
          </div>
        )}
      </div>

      {!canManage && (
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm">
          Only an administrator or treasurer can import and post online gifts. You can view what is waiting below.
        </div>
      )}

      {note && (
        <div className={`p-4 rounded-xl border text-sm flex items-start gap-2 ${
          note.kind === 'ok' ? 'bg-green-50 border-green-200 text-green-800'
          : note.kind === 'warn' ? 'bg-amber-50 border-amber-200 text-amber-800'
          : 'bg-red-50 border-red-200 text-red-700'}`}>
          {note.kind === 'ok' ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
          <div className="flex-1">{note.text}</div>
          <button onClick={() => setNote(null)} aria-label="Dismiss"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* ---------------- Upload ---------------- */}
      {(fp || dp) && canManage && (
        <section className="bg-white rounded-2xl shadow-md border border-gray-100 p-6">
          <div className="flex flex-col md:flex-row gap-6">
            <div className="md:w-1/3">
              <h3 className="font-bold text-gray-800 mb-2">1. {dp ? `Upload ${provider.label} emails` : `Upload a ${provider.label} export`}</h3>
              <ul className="text-sm text-gray-600 list-disc ml-5 space-y-1">
                {(fp ?? dp)!.exportSteps.map(s => <li key={s}>{s}</li>)}
              </ul>
              {fp && <p className="text-xs text-gray-400 mt-3">Overlapping date ranges are fine — gifts already brought in are recognised and skipped.</p>}
            </div>
            <div className="flex-1">
              {dp && !docParsed ? (
                <div className="space-y-3">
                  <label className="flex flex-col items-center justify-center h-32 border-2 border-dashed border-gray-300 rounded-xl cursor-pointer hover:border-church-500 hover:bg-church-50 transition-colors">
                    <Upload className="w-7 h-7 text-gray-400 mb-1" />
                    <span className="text-sm font-medium text-gray-600">Choose the e-Transfer emails</span>
                    <span className="text-xs text-gray-400">.eml or .mbox — select as many as you like</span>
                    <input type="file" multiple accept={dp.accept} className="hidden" data-testid="giving-files"
                      onChange={e => { const f = e.target.files ? [...e.target.files] : []; e.target.value = ''; onDocs(f); }} />
                  </label>
                  <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} rows={4} data-testid="giving-paste"
                    placeholder={dp.pasteHint} className="w-full border border-gray-300 rounded-xl p-3 text-sm font-mono" />
                  {pasteText.trim() && (
                    <button onClick={() => onDocs(null, pasteText)} disabled={busy}
                      className="px-4 py-2 rounded-lg bg-church-600 text-white text-sm font-semibold disabled:opacity-50">Read pasted emails</button>
                  )}
                </div>
              ) : fp && !table ? (
                <label className="flex flex-col items-center justify-center h-40 border-2 border-dashed border-gray-300 rounded-xl cursor-pointer hover:border-church-500 hover:bg-church-50 transition-colors">
                  <Upload className="w-8 h-8 text-gray-400 mb-2" />
                  <span className="text-sm font-medium text-gray-600">Choose the CSV file</span>
                  <span className="text-xs text-gray-400">or drop it here</span>
                  <input type="file" accept={fp.accept} className="hidden" data-testid="giving-file"
                    onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
                </label>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm"><span className="font-semibold">{fileName}</span>{table && <span className="text-gray-400"> · {table.rows.length} rows</span>}</div>
                    <div className="flex items-center gap-3">
                      {fp && <button onClick={() => setShowMapping(s => !s)} className="text-sm text-church-600 flex items-center gap-1">
                        <SlidersHorizontal className="w-4 h-4" /> Columns
                      </button>}
                      <button onClick={clearUpload} className="text-sm text-gray-500">Cancel</button>
                    </div>
                  </div>

                  {fp && table && showMapping && (
                    <div className="border border-gray-200 rounded-xl p-4 bg-gray-50">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-xs text-gray-500">Match the file's columns to SafeTrack. Recognised columns are filled in already.</p>
                        <label className="text-xs text-gray-600 flex items-center gap-2">Date order
                          <select value={dateOrder} onChange={e => setDateOrder(e.target.value as DateOrder)} className="border rounded px-1 py-0.5">
                            <option value="auto">Auto</option><option value="mdy">Month/Day/Year</option>
                            <option value="dmy">Day/Month/Year</option><option value="ymd">Year-Month-Day</option>
                          </select>
                        </label>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-2">
                        {fp.fields.map(f => (
                          <label key={f.key} className="text-xs text-gray-600 flex items-center justify-between gap-2" title={f.hint}>
                            <span className={f.required ? 'font-semibold text-gray-800' : ''}>{f.label}{f.required ? ' *' : ''}</span>
                            <select value={mapping[f.key] ?? ''} className="border rounded px-1 py-0.5 max-w-[11rem]"
                              onChange={e => setMapping(m => ({ ...m, [f.key]: e.target.value === '' ? undefined : Number(e.target.value) }))}>
                              <option value="">—</option>
                              {table.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                            </select>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {missing.length > 0 ? (
                    <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                      Choose a column for: {missing.map(f => f.label).join(', ')}.
                    </div>
                  ) : parsed && (
                    <>
                      <div className="grid grid-cols-3 gap-3 text-center">
                        <div className="p-3 rounded-xl bg-green-50"><div className="text-2xl font-bold text-green-700">{parsed.gifts.length}</div><div className="text-xs text-green-700">{dp ? 'e-Transfers' : 'online gifts'}</div></div>
                        <div className="p-3 rounded-xl bg-gray-50"><div className="text-2xl font-bold text-gray-700">{money(parsed.gifts.reduce((s, g) => s + g.amount, 0))}</div><div className="text-xs text-gray-500">gross</div></div>
                        <button onClick={() => setShowSkipped(s => !s)} className="p-3 rounded-xl bg-amber-50 hover:bg-amber-100">
                          <div className="text-2xl font-bold text-amber-700">{parsed.skipped.length}</div><div className="text-xs text-amber-700">skipped {parsed.skipped.length > 0 && '(show)'}</div>
                        </button>
                      </div>
                      {parsed.warnings.map(w => <p key={w} className="text-xs text-amber-700 flex gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{w}</p>)}
                      {showSkipped && parsed.skipped.length > 0 && (
                        <div className="max-h-48 overflow-auto border rounded-lg text-xs">
                          <table className="w-full">
                            <tbody>{parsed.skipped.map(s => (
                              <tr key={s.line} className="border-b last:border-0"><td className="p-1.5 text-gray-400 w-16">{dp ? '#' : 'Line '}{s.line}</td><td className="p-1.5 text-gray-600">{s.summary}</td><td className="p-1.5 text-amber-700">{s.reason}</td></tr>
                            ))}</tbody>
                          </table>
                        </div>
                      )}
                      <button onClick={stage} disabled={busy || parsed.gifts.length === 0}
                        className="w-full py-2.5 rounded-xl bg-church-600 text-white font-semibold hover:bg-church-800 disabled:opacity-50">
                        Add {parsed.gifts.length} gift{parsed.gifts.length === 1 ? '' : 's'} for review
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ---------------- Review ---------------- */}
      <section className="space-y-4">
        <div className="flex items-end justify-between">
          <div>
            <h3 className="font-bold text-gray-800">2. Review and post</h3>
            <p className="text-sm text-gray-500">
              {queue === undefined ? 'Loading…' : active.length === 0 ? `Nothing waiting from ${provider.label}.` :
                `${active.length} gift${active.length === 1 ? '' : 's'} waiting · ${active.filter(r => r.ready).length} ready to post`}
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-1 text-gray-600">Group by
              <select value={groupBy} onChange={e => setGroupBy(e.target.value as typeof groupBy)} className="border rounded px-1 py-0.5">
                <option value="auto">Auto</option>{provider.kind === 'file' && <option value="deposit">{provider.label} batch / deposit</option>}
                <option value="date">Gift date</option><option value="week">Week (Mon–Sun)</option>
              </select>
            </label>
            {ignoredRows.length > 0 && (
              <button onClick={() => setShowIgnored(s => !s)} className="text-gray-500 flex items-center gap-1">
                {showIgnored ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />} {ignoredRows.length} ignored
              </button>
            )}
          </div>
        </div>

        {fundRows.length > 0 && (
          <div className="bg-white rounded-2xl shadow-md border border-gray-100 p-4">
            <h4 className="text-sm font-semibold text-gray-700 mb-2">Funds</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {fundRows.map(f => (
                <div key={f.key} className="flex items-center justify-between gap-3 text-sm border border-gray-100 rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <div className="font-medium text-gray-800 truncate">{f.label}</div>
                    <div className="text-xs text-gray-400">{f.count} gift{f.count === 1 ? '' : 's'} · {money(f.total)}</div>
                  </div>
                  <div className="flex items-center shrink-0">
                    <span className="text-gray-400 mr-2">→</span>
                    <select value={f.fundId ?? ''} disabled={!canManage} data-testid={`fund-map-${f.key}`}
                      onChange={e => setFundChoice(c => ({ ...c, [f.key]: e.target.value }))}
                      className={`border rounded px-2 py-1 ${f.fundId ? '' : 'border-red-300 bg-red-50'}`}>
                      <option value="">Choose fund…</option>
                      {(funds ?? []).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                    <ReasonBadge reason={f.fundId ? f.reason : undefined} weak={f.reason === 'guess'} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {canManage && unmatchedPayers.size > 0 && (
          <div className="flex items-center justify-between p-3 rounded-xl bg-blue-50 border border-blue-100 text-sm">
            <span className="text-blue-800">{unmatchedPayers.size} payer{unmatchedPayers.size === 1 ? ' is' : 's are'} not in the Giver Registry. Pick them below, or add them all as new givers.</span>
            <button onClick={createAllUnmatched} disabled={busy} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white border border-blue-200 text-blue-700 font-medium hover:bg-blue-100 disabled:opacity-50">
              <UserPlus className="w-4 h-4" /> Add {unmatchedPayers.size} new giver{unmatchedPayers.size === 1 ? '' : 's'}
            </button>
          </div>
        )}

        {groups.map(g => (
            <div key={g.key} className="bg-white rounded-2xl shadow-md border border-gray-100 overflow-hidden" data-testid="giving-group">
              <div className="flex items-center gap-3 px-4 py-3 bg-gray-50 border-b border-gray-100">
                {canManage && (
                  <input type="checkbox" className="w-4 h-4" checked={selected.has(g.key)} disabled={g.ready.length === 0}
                    onChange={() => toggleGroup(g.key)} aria-label={`Select ${g.label}`} />
                )}
                <div className="flex-1">
                  <div className="font-semibold text-gray-800">{g.label}</div>
                  <div className="text-xs text-gray-500">{g.dateRange} · {g.items.length} gift{g.items.length === 1 ? '' : 's'}
                    {g.unresolved > 0 && <span className="text-red-600"> · {g.unresolved} need a giver or fund</span>}
                    {g.pending > 0 && <span className="text-amber-600"> · {g.pending} not completed yet</span>}
                  </div>
                </div>
                <div className="text-right text-sm">
                  <div className="font-bold text-gray-800">{money(g.gross)}</div>
                  <div className="text-xs text-gray-500">fees {money(g.fees)} · deposit {money(g.gross - g.fees)}</div>
                </div>
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-500 border-b border-gray-100">
                  <tr>
                    <th className="text-left p-2 w-24">Date</th><th className="text-left p-2">Payer</th>
                    <th className="text-left p-2 hidden lg:table-cell">Fund</th><th className="text-left p-2 hidden md:table-cell w-24">Method</th>
                    <th className="text-right p-2 w-24">Amount</th><th className="text-right p-2 w-20 hidden md:table-cell">Fee</th>
                    <th className="text-left p-2 w-72">Giver</th><th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {g.items.map(r => (
                    <tr key={r.id} className={`border-b border-gray-50 last:border-0 ${r.status !== 'succeeded' ? 'opacity-60' : ''}`}>
                      <td className="p-2 text-gray-600">{formatDate(r.giftDate)}</td>
                      <td className="p-2">
                        <div className="font-medium text-gray-800">{payerLabel(r)}</div>
                        <div className="text-xs text-gray-400">{[
                          r.payerEnvelope !== undefined && hasPayerIdentity(r) ? `Env #${r.payerEnvelope}` : '',
                          r.payerEmail, r.payerEnvelope !== undefined && !giverById.has(r.giverIdEff ?? '') && !hasPayerIdentity(r) ? 'not in registry' : '',
                          r.externalId.startsWith('H') && /^H[0-9a-f]{8}-\d+$/.test(r.externalId) ? '' : r.externalId,
                        ].filter(Boolean).join(' · ')}</div>
                        {r.status !== 'succeeded' && <span className="text-[10px] uppercase font-semibold text-amber-700">{r.status}</span>}
                      </td>
                      <td className="p-2 text-gray-600 hidden lg:table-cell">
                        {fundKeyOf(r) ? (r.fundName || r.fundKey) : (
                          <div>
                            <div className="flex items-center">
                              <select value={r.fundIdEff ?? ''} disabled={!canManage} data-testid="row-fund-select"
                                onChange={e => setRowFundChoice(c => ({ ...c, [r.id]: e.target.value }))}
                                className={`border rounded px-1 py-1 w-32 ${r.fundIdEff ? '' : 'border-red-300 bg-red-50'}`}>
                                <option value="">Choose fund…</option>
                                {(funds ?? []).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                              </select>
                              <ReasonBadge reason={r.fundIdEff ? r.fundReason : undefined} weak={r.fundReason === 'guess'} />
                            </div>
                            {r.memo && <div className="text-xs text-gray-400 mt-0.5 truncate max-w-[14rem]" title={r.memo}>“{r.memo}”</div>}
                          </div>
                        )}
                      </td>
                      <td className="p-2 text-gray-600 hidden md:table-cell">{METHOD_LABEL[r.method] ?? r.method}</td>
                      <td className="p-2 text-right font-semibold">{money(r.amount)}</td>
                      <td className="p-2 text-right text-gray-500 hidden md:table-cell">{money(r.fee)}</td>
                      <td className="p-2">
                        <div className="flex items-center gap-1">
                          <select value={r.giverIdEff ?? ''} disabled={!canManage} data-testid="giver-select"
                            onChange={e => setGiverChoice(c => ({ ...c, [r.id]: e.target.value }))}
                            className={`border rounded px-1 py-1 w-56 ${r.giverIdEff ? '' : 'border-red-300 bg-red-50'}`}>
                            <option value="">{r.candidates?.length ? `${r.candidates.length} possible matches…` : 'Choose giver…'}</option>
                            {r.candidates?.length ? (
                              <optgroup label="Possible matches">
                                {r.candidates.map(id => { const x = giverById.get(id); return x && <option key={id} value={id}>{x.name} (#{x.envelopeNumber})</option>; })}
                              </optgroup>
                            ) : null}
                            <optgroup label="All givers">
                              {giverOptions.map(x => <option key={x.id} value={x.id}>{x.name} (#{x.envelopeNumber})</option>)}
                            </optgroup>
                          </select>
                          {r.giverIdEff ? <ReasonBadge reason={r.giverReason} weak={r.giverReason === 'name'} /> : canManage && (
                            <button title="Add as a new giver" onClick={() => run(async () => { await createGiver([r]); })}
                              className="p-1 rounded text-blue-600 hover:bg-blue-50"><UserPlus className="w-4 h-4" /></button>
                          )}
                        </div>
                      </td>
                      <td className="p-2">
                        {canManage && (
                          <button title="Ignore this gift (it will not be posted)" onClick={() => run(() => setIgnored([r.id], true))}
                            className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"><EyeOff className="w-4 h-4" /></button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
        ))}

        {showIgnored && ignoredRows.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-200 p-4">
            <h4 className="text-sm font-semibold text-gray-600 mb-2">Ignored gifts (not posted)</h4>
            {ignoredRows.map(r => (
              <div key={r.id} className="flex items-center justify-between text-sm py-1 border-b last:border-0 border-gray-100">
                <span className="text-gray-600">{formatDate(r.giftDate)} · {payerLabel(r)} · {money(r.amount)} · {r.externalId}</span>
                {canManage && <button onClick={() => run(() => setIgnored([r.id], false))} className="text-church-600 text-xs font-medium">Restore</button>}
              </div>
            ))}
          </div>
        )}
      </section>

      {canManage && groups.length > 0 && (
        <div className="fixed bottom-0 left-64 right-0 bg-white/95 backdrop-blur border-t border-gray-200 px-8 py-3 flex items-center justify-between z-40">
          <div className="text-sm text-gray-600">
            {selectedBatches === 0 ? 'Tick the groups to post. Each group becomes one batch.' :
              `${selectedBatches} batch${selectedBatches === 1 ? '' : 'es'} · ${selectedReady} gifts. Gifts still needing a giver or fund stay here.`}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setSelected(new Set(groups.filter(g => g.ready.length).map(g => g.key)))} className="text-sm text-church-600 px-3">Select all</button>
            <button onClick={postSelected} disabled={busy || selectedBatches === 0} data-testid="post-batches"
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-church-600 text-white font-semibold hover:bg-church-800 disabled:opacity-50">
              <Send className="w-4 h-4" /> Post {selectedBatches || ''} batch{selectedBatches === 1 ? '' : 'es'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default GivingImport;
