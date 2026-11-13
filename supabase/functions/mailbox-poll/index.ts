// SafeTrack: automatic e-Transfer intake.
//
// Reads each church's giving mailbox (IMAP, or Microsoft 365 via Graph),
// keeps every email raw, stages the gifts and posts confident ones into an
// open weekly batch. Anything doubtful is flagged and waits for a person.
//
//   Scheduler (pg_cron + pg_net):  POST {action:'poll'}  header x-poll-secret
//   Admin / treasurer in the app:  POST {action:'poll'|'test', church_id}  with their session
//
// Deployed with --no-verify-jwt because the scheduler has no user session;
// every request is authenticated here instead.
import { createClient } from '@supabase/supabase-js';
import { connectorFor, pollMailbox, type MailboxSettings, type Sink } from '../_shared/mailbox.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const url = Deno.env.get('SUPABASE_URL')!;
const secretKey = (() => {
  try { return JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default; } catch { return undefined; }
})() ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const publishableKey = (() => {
  try { return JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}').default; } catch { return undefined; }
})() ?? Deno.env.get('SUPABASE_ANON_KEY');
const admin = createClient(url, secretKey!, { auth: { persistSession: false, autoRefreshToken: false } });

const must = <T>(r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data;
};

function sinkFor(churchId: string, source: 'imap' | 'graph'): Sink {
  return {
    async ingest(message, gift, skip) {
      return must(await admin.rpc('ingest_inbound_email_server', {
        p_church_id: churchId, p_provider: 'e_transfer', p_source: source,
        p_message: message, p_gift: gift, p_skip_reason: skip,
      })) as { status: string };
    },
    async autoPost() {
      return must(await admin.rpc('auto_post_external_server', { p_church_id: churchId, p_provider: 'e_transfer' })) as Record<string, unknown>;
    },
    async saveResult(cursor, error, result) {
      must(await admin.rpc('mailbox_poll_result_server', { p_church_id: churchId, p_cursor: cursor, p_error: error, p_result: result }));
    },
  };
}

async function runFor(rows: { church_id: string; settings: MailboxSettings; secret: string | null }[], action: 'poll' | 'test') {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const s = { ...r.settings, church_id: r.church_id };
    try {
      const connector = connectorFor(s, r.secret ?? '');
      if (action === 'test') { out[r.church_id] = await connector.test(); continue; }
      out[r.church_id] = await pollMailbox(s, connector, sinkFor(r.church_id, s.kind));
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (action === 'poll') await admin.rpc('mailbox_poll_result_server', { p_church_id: r.church_id, p_cursor: {}, p_error: msg, p_result: {} });
      out[r.church_id] = { ok: false, error: msg };
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const body = await req.json().catch(() => ({}));
  const action = body.action === 'test' ? 'test' : 'poll';

  try {
    // 1. Scheduler: shared secret kept in Vault
    const given = req.headers.get('x-poll-secret');
    if (given) {
      const expected = must(await admin.rpc('mailbox_poll_secret_server')) as string | null;
      if (!expected || given !== expected) return json({ error: 'Not authorized' }, 401);
      const rows = must(await admin.rpc('mailboxes_due_server', { p_church_id: null })) as any[];
      return json({ ok: true, results: await runFor(rows, 'poll') });
    }

    // 2. A signed-in administrator / treasurer, for their own church
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !body.church_id) return json({ error: 'Not authorized' }, 401);
    const user = createClient(url, publishableKey!, {
      global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: who } = await user.auth.getUser(auth.slice(7));
    if (!who?.user) return json({ error: 'Not authorized' }, 401);
    const { error: roleErr } = await user.rpc('get_mailbox_settings', { p_church_id: body.church_id });  // checks the role
    if (roleErr) return json({ error: 'Not authorized' }, 403);
    const rows = must(await admin.rpc('mailboxes_due_server', { p_church_id: body.church_id })) as any[];
    if (!rows.length) return json({ error: 'No mailbox is set up for this church yet' }, 400);
    const result = (await runFor(rows, action))[body.church_id];
    return json(result);
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 500);
  }
});
