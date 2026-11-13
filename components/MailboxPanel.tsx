import React, { useEffect, useState } from 'react';
import PostalMime from 'postal-mime';
import { AlertTriangle, CheckCircle2, Inbox, Loader2, Mail, PlugZap, RefreshCw, Save, X } from 'lucide-react';
import { useLive } from '../services/repo';
import { getInboundRaw, getMailboxSettings, listInbox, runMailbox, saveMailboxSettings } from '../services/giving/repo';
import type { MailboxSettingsView } from '../services/giving/types';

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

const STATUS_STYLE: Record<string, string> = {
  staged: 'bg-green-50 text-green-700 border-green-200',
  duplicate: 'bg-gray-50 text-gray-500 border-gray-200',
  skipped: 'bg-amber-50 text-amber-700 border-amber-200',
  error: 'bg-red-50 text-red-700 border-red-200',
};

/** Shows an email exactly as received, with a readable view. */
export const EmailViewer: React.FC<{ inboundId: string; onClose: () => void }> = ({ inboundId, onClose }) => {
  const [raw, setRaw] = useState<string | null>(null);
  const [readable, setReadable] = useState<{ subject?: string; from?: string; date?: string; text: string } | null>(null);
  const [tab, setTab] = useState<'readable' | 'raw'>('readable');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    getInboundRaw(inboundId).then(async r => {
      setRaw(r);
      const m = await PostalMime.parse(r);
      setReadable({ subject: m.subject, from: m.from?.address, date: m.date, text: m.text || (m.html ?? '').replace(/<[^>]+>/g, ' ') });
    }).catch(e => setErr((e as Error).message));
  }, [inboundId]);
  return (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg text-sm">
            {(['readable', 'raw'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} className={`px-3 py-1 rounded-md ${tab === t ? 'bg-white shadow font-semibold' : 'text-gray-500'}`}>
                {t === 'readable' ? 'Email' : 'Original (raw)'}
              </button>
            ))}
          </div>
          <button onClick={onClose} aria-label="Close"><X className="w-5 h-5 text-gray-500" /></button>
        </div>
        <div className="overflow-auto p-5 text-sm">
          {err && <p className="text-red-600">{err}</p>}
          {!raw && !err && <p className="text-gray-400">Loading…</p>}
          {tab === 'readable' && readable && (
            <div className="space-y-2">
              <div className="text-xs text-gray-500">From <b>{readable.from}</b> · {when(readable.date)}</div>
              <div className="font-semibold">{readable.subject}</div>
              <pre className="whitespace-pre-wrap font-sans text-gray-800 bg-gray-50 rounded-lg p-3">{readable.text}</pre>
            </div>
          )}
          {tab === 'raw' && raw && <pre className="whitespace-pre-wrap break-all font-mono text-xs text-gray-700" data-testid="raw-email">{raw}</pre>}
        </div>
      </div>
    </div>
  );
};

const empty: Partial<MailboxSettingsView> = {
  kind: 'imap', enabled: false, auto_post: true, time_zone: 'America/Toronto',
  since_date: new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10), sender_filter: 'payments.interac.ca',
  imap_port: 993, imap_tls: true, imap_folder: 'INBOX', graph_folder: 'inbox',
};

const MailboxPanel: React.FC<{ isAdmin: boolean; canManage: boolean }> = ({ isAdmin, canManage }) => {
  const saved = useLive(getMailboxSettings, []);
  const inbox = useLive(() => (canManage ? listInbox(50) : Promise.resolve([])), [canManage]);
  const [form, setForm] = useState<Partial<MailboxSettingsView>>(empty);
  const [secret, setSecret] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => { if (saved) setForm({ ...empty, ...saved }); }, [saved]);
  const set = (k: keyof MailboxSettingsView, v: unknown) => setForm(f => ({ ...f, [k]: v }));
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setMsg(null);
    try { await fn(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(null); }
  };

  const save = () => run('save', async () => {
    const { has_secret: _h, last_polled_at: _a, last_success_at: _b, last_error: _c, last_result: _d, ...settings } = form as MailboxSettingsView;
    await saveMailboxSettings(settings, secret);
    setSecret('');
    setMsg({ ok: true, text: 'Saved.' });
  });
  const test = () => run('test', async () => {
    const r = await runMailbox('test');
    setMsg(r.ok ? { ok: true, text: r.detail ?? 'Connected.' } : { ok: false, text: r.error ?? 'Could not connect.' });
  });
  const pollNow = () => run('poll', async () => {
    const r = await runMailbox('poll');
    const s = r.summary ?? {};
    const ap = (s.auto_post ?? {}) as Record<string, unknown>;
    setMsg(r.ok
      ? { ok: true, text: `Read ${s.fetched ?? 0} new email(s): ${s.staged ?? 0} gift(s), ${s.duplicate ?? 0} already in, ${s.skipped ?? 0} not deposits.`
          + (ap.posted !== undefined ? ` ${ap.posted} posted automatically, ${ap.held_for_review} waiting for review.` : '')
          + (s.more_waiting ? ' More waiting — they will be read on the next run.' : '') }
      : { ok: false, text: r.error ?? 'Failed.' });
  });

  const configured = !!saved;
  const status = saved?.last_error
    ? <span className="text-red-600 flex items-center gap-1"><AlertTriangle className="w-4 h-4" /> Last check failed: {saved.last_error}</span>
    : saved?.last_success_at
      ? <span className="text-green-700 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Last checked {when(saved.last_success_at)}</span>
      : <span className="text-gray-500">Not checked yet</span>;
  const input = 'border border-gray-300 rounded-lg px-2 py-1.5 text-sm w-full disabled:bg-gray-50';

  return (
    <section className="bg-white rounded-2xl shadow-md border border-gray-100 p-6 space-y-4" data-testid="mailbox-panel">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-bold text-gray-800 flex items-center gap-2"><Inbox className="w-5 h-5 text-church-500" /> Automatic intake from the giving mailbox</h3>
          <p className="text-sm text-gray-500">
            {configured
              ? <>{saved!.enabled ? 'On' : 'Off'} · {saved!.kind === 'graph' ? `Microsoft 365 (${saved!.graph_mailbox})` : `IMAP (${saved!.imap_username}@${saved!.imap_host})`}
                  {' · '}checks every 10 minutes · {saved!.auto_post ? 'confident gifts post to the weekly batch' : 'everything waits for review'}</>
              : 'Read Interac notifications straight from the mailbox. Nothing in the mailbox is changed.'}
          </p>
          {configured && <div className="text-sm mt-1">{status}</div>}
        </div>
        <div className="flex gap-2 shrink-0">
          {configured && canManage && (
            <button onClick={pollNow} disabled={!!busy} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-church-600 text-white text-sm font-semibold disabled:opacity-50">
              {busy === 'poll' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Check now
            </button>
          )}
          {isAdmin && <button onClick={() => setOpen(o => !o)} className="px-3 py-1.5 rounded-lg border text-sm">{open ? 'Close' : configured ? 'Settings' : 'Set up'}</button>}
        </div>
      </div>

      {msg && <div className={`p-3 rounded-lg text-sm border ${msg.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-700'}`}>{msg.text}</div>}

      {open && isAdmin && (
        <div className="border border-gray-200 rounded-xl p-4 bg-gray-50 space-y-4">
          <div className="flex gap-2">
            {(['imap', 'graph'] as const).map(k => (
              <button key={k} onClick={() => set('kind', k)}
                className={`px-3 py-1.5 rounded-lg text-sm border ${form.kind === k ? 'bg-white border-church-500 text-church-800 font-semibold' : 'border-gray-300 text-gray-500'}`}>
                {k === 'imap' ? 'IMAP mailbox' : 'Microsoft 365'}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {form.kind === 'imap' ? (<>
              <label className="text-xs text-gray-600">Server<input className={input} value={form.imap_host ?? ''} onChange={e => set('imap_host', e.target.value)} placeholder="mail.yourchurch.ca" /></label>
              <label className="text-xs text-gray-600">Port<input className={input} type="number" value={form.imap_port ?? 993} onChange={e => set('imap_port', Number(e.target.value))} /></label>
              <label className="text-xs text-gray-600 flex items-end gap-2 pb-1"><input type="checkbox" checked={form.imap_tls !== false} onChange={e => set('imap_tls', e.target.checked)} /> Secure (SSL/TLS)</label>
              <label className="text-xs text-gray-600">Username<input className={input} value={form.imap_username ?? ''} onChange={e => set('imap_username', e.target.value)} placeholder="giving@yourchurch.ca" /></label>
              <label className="text-xs text-gray-600">Password / app password
                <input className={input} type="password" autoComplete="new-password" value={secret} onChange={e => setSecret(e.target.value)}
                  placeholder={saved?.has_secret ? 'Saved — leave blank to keep' : ''} /></label>
              <label className="text-xs text-gray-600">Folder<input className={input} value={form.imap_folder ?? 'INBOX'} onChange={e => set('imap_folder', e.target.value)} /></label>
            </>) : (<>
              <label className="text-xs text-gray-600">Mailbox<input className={input} value={form.graph_mailbox ?? ''} onChange={e => set('graph_mailbox', e.target.value)} placeholder="giving@yourchurch.ca" /></label>
              <label className="text-xs text-gray-600">Tenant ID<input className={input} value={form.graph_tenant_id ?? ''} onChange={e => set('graph_tenant_id', e.target.value)} /></label>
              <label className="text-xs text-gray-600">App (client) ID<input className={input} value={form.graph_client_id ?? ''} onChange={e => set('graph_client_id', e.target.value)} /></label>
              <label className="text-xs text-gray-600">Client secret
                <input className={input} type="password" autoComplete="new-password" value={secret} onChange={e => setSecret(e.target.value)}
                  placeholder={saved?.has_secret ? 'Saved — leave blank to keep' : ''} /></label>
              <label className="text-xs text-gray-600">Folder<input className={input} value={form.graph_folder ?? 'inbox'} onChange={e => set('graph_folder', e.target.value)} /></label>
              <p className="text-xs text-gray-500 md:col-span-1">Needs an Entra app with <b>Mail.Read</b> (application) limited to this mailbox. See docs/GIVING_PROVIDERS.md.</p>
            </>)}
            <label className="text-xs text-gray-600">Only emails from<input className={input} value={form.sender_filter ?? ''} onChange={e => set('sender_filter', e.target.value)} placeholder="(any sender)" /></label>
            <label className="text-xs text-gray-600">Ignore emails before<input className={input} type="date" value={form.since_date ?? ''} onChange={e => set('since_date', e.target.value)} /></label>
            <label className="text-xs text-gray-600">Time zone<input className={input} value={form.time_zone ?? 'America/Toronto'} onChange={e => set('time_zone', e.target.value)} /></label>
          </div>
          <div className="flex flex-wrap items-center gap-5 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!form.enabled} onChange={e => set('enabled', e.target.checked)} /> Check automatically every 10 minutes</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={form.auto_post !== false} onChange={e => set('auto_post', e.target.checked)} /> Post confident gifts to the weekly batch (flagged ones always wait)</label>
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={!!busy} className="flex items-center gap-1 px-4 py-2 rounded-lg bg-church-600 text-white text-sm font-semibold disabled:opacity-50">
              {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
            </button>
            {configured && (
              <button onClick={test} disabled={!!busy} className="flex items-center gap-1 px-4 py-2 rounded-lg border text-sm disabled:opacity-50">
                {busy === 'test' ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />} Test connection
              </button>
            )}
          </div>
          <p className="text-xs text-gray-400">The password is stored encrypted on the server and is never shown again. SafeTrack only reads the mailbox; it never deletes, moves or marks emails.</p>
        </div>
      )}

      {canManage && (inbox?.length ?? 0) > 0 && (
        <div>
          <button onClick={() => setShowLog(s => !s)} className="text-sm text-church-600 flex items-center gap-1">
            <Mail className="w-4 h-4" /> {showLog ? 'Hide' : 'Show'} inbox log ({inbox!.length} most recent)
            {inbox!.some(m => m.status === 'error' || m.status === 'skipped') && <span className="ml-1 text-amber-700">· {inbox!.filter(m => m.status === 'error' || m.status === 'skipped').length} not brought in</span>}
          </button>
          {showLog && (
            <div className="mt-2 max-h-72 overflow-auto border rounded-xl">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500 sticky top-0"><tr>
                  <th className="text-left p-2">Received</th><th className="text-left p-2">Subject</th><th className="text-left p-2">Result</th><th />
                </tr></thead>
                <tbody>
                  {inbox!.map(m => (
                    <tr key={m.id} className="border-t">
                      <td className="p-2 text-gray-500 whitespace-nowrap">{when(m.receivedAt ?? m.createdAt)}</td>
                      <td className="p-2 text-gray-700">{m.subject ?? '(no subject)'}<div className="text-gray-400">{m.from}</div></td>
                      <td className="p-2"><span className={`px-1.5 py-0.5 rounded border ${STATUS_STYLE[m.status]}`}>{m.status}</span>
                        {m.reason && <div className="text-gray-500 mt-0.5">{m.reason}</div>}</td>
                      <td className="p-2"><button onClick={() => setViewing(m.id)} className="text-church-600 underline">View</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {viewing && <EmailViewer inboundId={viewing} onClose={() => setViewing(null)} />}
    </section>
  );
};

export default MailboxPanel;
