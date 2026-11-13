/**
 * Mailbox connectors + the poll loop for automatic e-Transfer intake.
 *
 * Runs in the mailbox-poll Edge Function (Deno; bare imports resolved by
 * supabase/functions/mailbox-poll/deno.json) and in Node for tests.
 *
 * A connector only has to hand back new raw emails and a cursor. Everything
 * else — reading the notification, storing the raw email, staging the gift,
 * matching and auto-posting — is shared, so IMAP today and Microsoft 365
 * (Graph) later behave identically.
 */
import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';
import { emailPartsFromMime, parseInteracEmail, type InteracGift } from './interac.ts';

export interface MailboxSettings {
  church_id: string;
  kind: 'imap' | 'graph';
  enabled: boolean;
  auto_post: boolean;
  time_zone: string;
  since_date: string;                 // YYYY-MM-DD
  sender_filter: string | null;
  imap_host?: string | null;
  imap_port?: number | null;
  imap_tls?: boolean;
  imap_username?: string | null;
  imap_folder?: string;
  graph_tenant_id?: string | null;
  graph_client_id?: string | null;
  graph_mailbox?: string | null;
  graph_folder?: string;
  imap_uid_validity?: number | string | null;
  imap_last_uid?: number | string | null;
  graph_last_received?: string | null;
}

export interface RawMessage { key: string; receivedAt?: string; raw: string; position?: number }

export interface FetchResult {
  messages: RawMessage[];
  /** Cursor after *all* returned messages; the loop saves a partial cursor if it stops early. */
  cursorAfter: (lastProcessed: RawMessage | null) => Record<string, unknown>;
  more: boolean;                       // hit the per-run limit
}

export interface Connector {
  /** Connect and count what is waiting, without reading anything. */
  test(): Promise<{ ok: true; detail: string }>;
  fetchNew(limit: number): Promise<FetchResult>;
}

/** Where results go (Supabase RPCs in production, an array in tests). */
export interface Sink {
  ingest(message: { message_key: string; received_at?: string; from?: string; subject?: string; raw: string },
         gift: Record<string, unknown> | null, skipReason: string | null): Promise<{ status: string }>;
  autoPost(): Promise<Record<string, unknown>>;
  saveResult(cursor: Record<string, unknown>, error: string | null, result: Record<string, unknown>): Promise<void>;
}

export const MAX_PER_RUN = 200;
const MAX_RAW = 2_000_000;

// ---------------------------------------------------------------------------
// IMAP (read-only: EXAMINE, BODY.PEEK — nothing in the mailbox is changed)
// ---------------------------------------------------------------------------
export function imapConnector(s: MailboxSettings, password: string): Connector {
  const connect = async () => {
    if (!s.imap_host || !s.imap_username) throw new Error('IMAP host and username are required');
    const client = new ImapFlow({
      host: s.imap_host, port: Number(s.imap_port ?? 993), secure: s.imap_tls !== false,
      auth: { user: s.imap_username, pass: password },
      logger: false, socketTimeout: 60_000, greetingTimeout: 20_000, connectionTimeout: 20_000,
    });
    await client.connect();
    return client;
  };
  const criteria = (sinceUid: number) => {
    const c: Record<string, unknown> = { since: new Date(`${s.since_date}T00:00:00Z`) };
    if (s.sender_filter) c.from = s.sender_filter;
    if (sinceUid > 0) c.uid = `${sinceUid + 1}:*`;
    return c;
  };

  return {
    async test() {
      const client = await connect();
      try {
        const lock = await client.getMailboxLock(s.imap_folder || 'INBOX', { readOnly: true });
        try {
          const uids = (await client.search(criteria(0), { uid: true })) || [];
          return { ok: true, detail: `Connected. ${uids.length} matching email(s) since ${s.since_date} in ${s.imap_folder || 'INBOX'}.` };
        } finally { lock.release(); }
      } finally { await client.logout().catch(() => {}); }
    },

    async fetchNew(limit) {
      const client = await connect();
      try {
        const lock = await client.getMailboxLock(s.imap_folder || 'INBOX', { readOnly: true });
        try {
          const validity = Number(client.mailbox && typeof client.mailbox === 'object' ? client.mailbox.uidValidity : 0);
          // A new UIDVALIDITY means the server renumbered the folder: start over (duplicates are ignored downstream).
          const lastUid = Number(s.imap_uid_validity) === validity ? Number(s.imap_last_uid ?? 0) : 0;
          const found = ((await client.search(criteria(lastUid), { uid: true })) || [])
            .map(Number).filter(u => u > lastUid).sort((a, b) => a - b);
          const batch = found.slice(0, limit);
          const messages: RawMessage[] = [];
          if (batch.length) {
            for await (const m of client.fetch(batch.join(','), { uid: true, source: true, internalDate: true, envelope: true }, { uid: true })) {
              const raw = new TextDecoder().decode(m.source);
              messages.push({
                key: m.envelope?.messageId || `imap:${validity}:${m.uid}`,
                receivedAt: m.internalDate ? new Date(m.internalDate).toISOString() : undefined,
                raw: raw.length > MAX_RAW ? raw.slice(0, MAX_RAW) : raw,
                position: Number(m.uid),
              });
            }
            messages.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
          }
          return {
            messages,
            more: found.length > batch.length,
            cursorAfter: last => ({ imap_uid_validity: validity, imap_last_uid: last?.position ?? lastUid }),
          };
        } finally { lock.release(); }
      } finally { await client.logout().catch(() => {}); }
    },
  };
}

// ---------------------------------------------------------------------------
// Microsoft 365 via Microsoft Graph (app-only, Mail.Read limited to the one
// mailbox with an Exchange application access policy). Read-only.
// ---------------------------------------------------------------------------
export function graphConnector(s: MailboxSettings, clientSecret: string, fetchImpl: typeof fetch = fetch): Connector {
  const base = () => `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(s.graph_mailbox ?? '')}`;
  const token = async () => {
    if (!s.graph_tenant_id || !s.graph_client_id || !s.graph_mailbox) throw new Error('Tenant ID, client ID and mailbox are required');
    const res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(s.graph_tenant_id)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: s.graph_client_id, client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
      }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`Microsoft sign-in failed: ${j.error_description ?? j.error ?? res.status}`);
    return j.access_token as string;
  };
  const since = () => {
    const floor = new Date(`${s.since_date}T00:00:00Z`).toISOString();
    return s.graph_last_received && s.graph_last_received > floor ? s.graph_last_received : floor;
  };
  type Msg = { id: string; internetMessageId?: string; receivedDateTime: string; from?: { emailAddress?: { address?: string } } };
  const list = async (tok: string, limit: number) => {
    const filter = encodeURIComponent(`receivedDateTime ge ${since()}`);
    let url: string | undefined = `${base()}/mailFolders/${encodeURIComponent(s.graph_folder || 'inbox')}/messages`
      + `?$select=id,internetMessageId,receivedDateTime,from&$filter=${filter}&$orderby=receivedDateTime asc&$top=50`;
    const out: Msg[] = [];
    let more = false;
    while (url) {
      const res: Response = await fetchImpl(url, { headers: { Authorization: `Bearer ${tok}` } });
      // deno-lint-ignore no-explicit-any
      const j: any = await res.json();
      if (!res.ok) throw new Error(`Microsoft Graph: ${j.error?.message ?? res.status}`);
      for (const m of j.value as Msg[]) {
        const from = m.from?.emailAddress?.address ?? '';
        if (s.sender_filter && !from.toLowerCase().includes(s.sender_filter.toLowerCase())) continue;
        if (out.length >= limit) { more = true; break; }
        out.push(m);
      }
      url = more ? undefined : j['@odata.nextLink'];
    }
    return { out, more };
  };

  return {
    async test() {
      const tok = await token();
      const { out, more } = await list(tok, MAX_PER_RUN);
      return { ok: true, detail: `Connected to ${s.graph_mailbox}. ${out.length}${more ? '+' : ''} matching email(s) since ${since().slice(0, 10)}.` };
    },
    async fetchNew(limit) {
      const tok = await token();
      const { out, more } = await list(tok, limit);
      const messages: RawMessage[] = [];
      for (const m of out) {
        const res = await fetchImpl(`${base()}/messages/${encodeURIComponent(m.id)}/$value`, { headers: { Authorization: `Bearer ${tok}` } });
        if (!res.ok) throw new Error(`Microsoft Graph: could not read message (${res.status})`);
        const raw = await res.text();
        messages.push({ key: m.internetMessageId || `graph:${m.id}`, receivedAt: m.receivedDateTime, raw: raw.slice(0, MAX_RAW) });
      }
      return {
        messages, more,
        cursorAfter: last => (last?.receivedAt ? { graph_last_received: last.receivedAt } : {}),
      };
    },
  };
}

export function connectorFor(s: MailboxSettings, secret: string): Connector {
  if (!secret) throw new Error('No password / client secret saved for this mailbox');
  return s.kind === 'graph' ? graphConnector(s, secret) : imapConnector(s, secret);
}

// ---------------------------------------------------------------------------
// Email -> staging row
// ---------------------------------------------------------------------------
export function stagingRow(g: InteracGift): Record<string, unknown> {
  return {
    external_id: g.externalId, gift_date: g.giftDate, amount: g.amount.toFixed(2), fee: '0.00', currency: g.currency,
    payment_method: g.method, status: g.status, payer_external_id: g.payerExternalId ?? null,
    payer_envelope: g.payerEnvelope ?? null, payer_first_name: g.payerFirstName ?? null,
    payer_last_name: g.payerLastName ?? null, payer_name: g.payerName ?? null, payer_email: g.payerEmail ?? null,
    memo: g.memo ?? null, memo_raw: g.memoRaw ?? null, review_flags: g.flags, raw: g.raw,
  };
}

export async function readOne(m: RawMessage, timeZone: string) {
  const parsed = await PostalMime.parse(m.raw);
  const parts = emailPartsFromMime(parsed, m.receivedAt);
  const r = parseInteracEmail(parts, { timeZone });
  const message = { message_key: m.key, received_at: m.receivedAt, from: parsed.from?.address, subject: parsed.subject, raw: m.raw };
  return 'skip' in r
    ? { message, gift: null, skip: r.skip }
    : { message, gift: stagingRow(r.gift), skip: null };
}

// ---------------------------------------------------------------------------
// One poll of one mailbox
// ---------------------------------------------------------------------------
export async function pollMailbox(s: MailboxSettings, connector: Connector, sink: Sink, limit = MAX_PER_RUN) {
  const summary: Record<string, unknown> = { fetched: 0, staged: 0, duplicate: 0, skipped: 0, error: 0 };
  let cursor: Record<string, unknown> = {};
  let last: RawMessage | null = null;
  let res: FetchResult | null = null;
  try {
    res = await connector.fetchNew(limit);
    for (const m of res.messages) {
      let r: { message: Parameters<Sink['ingest']>[0]; gift: Record<string, unknown> | null; skip: string | null };
      try { r = await readOne(m, s.time_zone || 'America/Toronto'); }
      catch (e) { r = { message: { message_key: m.key, received_at: m.receivedAt, raw: m.raw }, gift: null, skip: `Could not read email: ${(e as Error).message}` }; }
      const out = await sink.ingest(r.message, r.gift, r.skip);   // throws only if the database is unreachable
      summary[out.status] = Number(summary[out.status] ?? 0) + 1;
      summary.fetched = Number(summary.fetched) + 1;
      last = m;
    }
    cursor = res.cursorAfter(last);
    if (res.more) summary.more_waiting = true;
    if (s.auto_post) summary.auto_post = await sink.autoPost();
    await sink.saveResult(cursor, null, summary);
    return { ok: true, summary };
  } catch (e) {
    // Save progress up to the last email stored, so nothing is read twice or skipped
    if (res && last) cursor = res.cursorAfter(last);
    const msg = (e as Error).message || String(e);
    await sink.saveResult(cursor, msg, summary).catch(() => {});
    return { ok: false, error: msg, summary };
  }
}
