/**
 * Mailbox poller: IMAP connector against a local IMAP server (hoodiecrow),
 * Graph connector against a fake Microsoft Graph, and the poll loop.
 * Run: npm run test:unit
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { graphConnector, imapConnector, pollMailbox, type MailboxSettings, type Sink } from '../../supabase/functions/_shared/mailbox';

const require = createRequire(import.meta.url);
const hoodiecrow = require('hoodiecrow-imap');

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`ok  ${name}`); };
const fx = (f: string) => readFileSync(new URL(`../fixtures/etransfer/${f}`, import.meta.url), 'utf8');
const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');
const other = crlf('From: Pastor <pastor@church.example>\nTo: giving@church.example\nSubject: Coffee?\nDate: Sun, 08 Nov 2026 09:00:00 -0500\nMessage-ID: <coffee@church>\n\nSee you Sunday\n');

const PORT = 1143;
const server = hoodiecrow({
  plugins: ['ID', 'UNSELECT', 'ENABLE', 'SPECIAL-USE'],
  storage: {
    INBOX: {
      messages: ['autodeposit.eml', 'html-only.eml', 'request.eml', 'french.eml'].map(f => ({ raw: crlf(fx(f)), internaldate: '08-Nov-2026 10:00:00 -0500' }))
        .concat([{ raw: other, internaldate: '08-Nov-2026 10:00:00 -0500' }]),
    },
  },
  users: { giving: { password: 'pw' } },
});
await new Promise<void>(r => server.listen(PORT, () => r()));

const base: MailboxSettings = {
  church_id: 'c1', kind: 'imap', enabled: true, auto_post: true, time_zone: 'America/Toronto',
  since_date: '2026-11-01', sender_filter: 'payments.interac.ca',
  imap_host: '127.0.0.1', imap_port: PORT, imap_tls: false, imap_username: 'giving', imap_folder: 'INBOX',
  imap_uid_validity: null, imap_last_uid: 0,
};

function memorySink() {
  const rows: { message: any; gift: any; skip: string | null }[] = [];
  const saved: { cursor: any; error: string | null; result: any }[] = [];
  const keys = new Set<string>();
  const sink: Sink = {
    async ingest(message, gift, skip) {
      if (keys.has(message.message_key)) return { status: 'duplicate' };
      keys.add(message.message_key);
      rows.push({ message, gift, skip });
      return { status: gift ? 'staged' : 'skipped' };
    },
    async autoPost() { return { posted: rows.filter(r => r.gift).length }; },
    async saveResult(cursor, error, result) { saved.push({ cursor, error, result }); },
  };
  return { sink, rows, saved };
}

try {
  await test('IMAP: test() counts matching mail without reading it', async () => {
    const r = await imapConnector(base, 'pw').test();
    assert.match(r.detail, /4 matching email\(s\)/);   // the pastor's email is filtered out
  });

  await test('IMAP: wrong password is reported, nothing saved as progress', async () => {
    const { sink, saved } = memorySink();
    const r = await pollMailbox(base, imapConnector(base, 'nope'), sink);
    assert.equal(r.ok, false);
    assert.equal(saved.length, 1);
    assert.ok(saved[0].error);
    assert.deepEqual(saved[0].cursor, {});
  });

  let cursor: any;
  await test('IMAP: reads new mail in batches, keeps raw email + exact memo, logs skipped notices', async () => {
    const { sink, rows, saved } = memorySink();
    const r1 = await pollMailbox(base, imapConnector(base, 'pw'), sink, 3);
    assert.equal(r1.ok, true);
    assert.equal(r1.summary.fetched, 3);
    assert.equal(r1.summary.more_waiting, true);
    cursor = saved[0].cursor;
    assert.equal(cursor.imap_last_uid, 3);
    const r2 = await pollMailbox({ ...base, ...cursor }, imapConnector({ ...base, ...cursor }, 'pw'), sink, 3);
    assert.equal(r2.summary.fetched, 1);
    assert.equal(saved[1].cursor.imap_last_uid, 4);

    const gifts = rows.filter(x => x.gift).map(x => x.gift);
    assert.deepEqual(gifts.map(g => g.external_id), ['C1AbCdEf2GhI', 'CA9ZyXwVuT87', 'CAFRENCH0001']);
    assert.equal(gifts[0].memo_raw, 'Tithe - env 100');
    assert.equal(gifts[0].payer_envelope, 100);
    assert.equal(gifts[0].gift_date, '2026-11-08');
    assert.deepEqual(gifts[0].review_flags, []);
    const skipped = rows.filter(x => !x.gift);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].skip!, /Not a deposit/);
    assert.match(skipped[0].message.raw, /Money request from BOB JONES/);
    assert.ok(rows.every(x => x.message.raw.length > 100 && x.message.message_key));
  });

  await test('IMAP: nothing new on the next run; a renumbered folder (new UIDVALIDITY) starts over safely', async () => {
    const { sink, saved } = memorySink();
    const r = await pollMailbox({ ...base, imap_uid_validity: cursor.imap_uid_validity, imap_last_uid: 4 },
      imapConnector({ ...base, imap_uid_validity: cursor.imap_uid_validity, imap_last_uid: 4 }, 'pw'), sink);
    assert.equal(r.summary.fetched, 0);
    assert.equal(saved[0].cursor.imap_last_uid, 4);
    const again = await pollMailbox({ ...base, imap_uid_validity: 999, imap_last_uid: 4 },
      imapConnector({ ...base, imap_uid_validity: 999, imap_last_uid: 4 }, 'pw'), memorySink().sink);
    assert.equal(again.summary.fetched, 4);
  });

  await test('Graph: token, paging, sender filter, raw MIME, cursor', async () => {
    const calls: string[] = [];
    const page1 = { value: [
      { id: 'a', internetMessageId: '<a@x>', receivedDateTime: '2026-11-08T15:00:00Z', from: { emailAddress: { address: 'notify@payments.interac.ca' } } },
      { id: 'b', internetMessageId: '<b@x>', receivedDateTime: '2026-11-08T16:00:00Z', from: { emailAddress: { address: 'pastor@church.example' } } },
    ], '@odata.nextLink': 'https://graph.microsoft.com/next' };
    const page2 = { value: [
      { id: 'c', internetMessageId: '<c@x>', receivedDateTime: '2026-11-09T13:01:00Z', from: { emailAddress: { address: 'notify@payments.interac.ca' } } },
    ] };
    const fake = (async (u: string, init?: RequestInit) => {
      calls.push(u);
      const ok = (body: unknown, text?: string) => new Response(text ?? JSON.stringify(body), { status: 200 });
      if (u.includes('/oauth2/v2.0/token')) {
        assert.match(String(init?.body), /client_secret=s3cret/);
        return ok({ access_token: 'T' });
      }
      assert.equal((init?.headers as any).Authorization, 'Bearer T');
      if (u.includes('/messages/a/$value')) return ok(null, crlf(fx('autodeposit.eml')));
      if (u.includes('/messages/c/$value')) return ok(null, crlf(fx('html-only.eml')));
      if (u === 'https://graph.microsoft.com/next') return ok(page2);
      if (u.includes('/mailFolders/inbox/messages')) { assert.match(decodeURIComponent(u), /receivedDateTime ge 2026-11-01/); return ok(page1); }
      throw new Error('unexpected ' + u);
    }) as typeof fetch;
    const s: MailboxSettings = { ...base, kind: 'graph', graph_tenant_id: 'tid', graph_client_id: 'cid', graph_mailbox: 'giving@church.example', graph_folder: 'inbox' };
    const { sink, rows, saved } = memorySink();
    const r = await pollMailbox(s, graphConnector(s, 's3cret', fake), sink);
    assert.equal(r.ok, true);
    assert.deepEqual(rows.map(x => x.gift?.external_id), ['C1AbCdEf2GhI', 'CA9ZyXwVuT87']);
    assert.deepEqual(rows.map(x => x.message.message_key), ['<a@x>', '<c@x>']);
    assert.equal(saved[0].cursor.graph_last_received, '2026-11-09T13:01:00Z');
    assert.ok(!calls.some(c => c.includes('/messages/b/')), 'filtered sender never downloaded');
  });

  await test('Graph: sign-in failure is reported', async () => {
    const fake = (async () => new Response(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret' }), { status: 401 })) as typeof fetch;
    const s: MailboxSettings = { ...base, kind: 'graph', graph_tenant_id: 'tid', graph_client_id: 'cid', graph_mailbox: 'g@c' };
    const { sink, saved } = memorySink();
    const r = await pollMailbox(s, graphConnector(s, 'bad', fake), sink);
    assert.equal(r.ok, false);
    assert.match(saved[0].error!, /Invalid client secret/);
  });
} finally {
  server.close();
}
console.log(`\n${passed} mailbox tests passed`);
