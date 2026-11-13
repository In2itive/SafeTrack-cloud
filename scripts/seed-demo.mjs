#!/usr/bin/env node
/**
 * Seed a demo church into a SafeTrack Supabase project, using only the
 * public API (the same calls the app makes), so every control is exercised:
 * real logins, two-teller sign-offs, blind audits, an admin adjustment.
 *
 *   node --env-file=.env scripts/seed-demo.mjs
 *
 * Env: VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY
 * Optional: DEMO_PASSWORD (default below), DEMO_EMAIL_DOMAIN (default in2itive.ca)
 * Requires "Confirm email" to be OFF on the target project (dev/demo only).
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const URL_ = process.env.VITE_SUPABASE_URL;
const KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!URL_ || !KEY) { console.error('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (see .env.example)'); process.exit(1); }
const PASSWORD = process.env.DEMO_PASSWORD || 'SafeTrack-Demo-2026';
const DOMAIN = process.env.DEMO_EMAIL_DOMAIN || 'in2itive.ca';
const CHURCH = 'Grace Community Church (Demo)';

const people = {
  admin:     { name: 'Pat Admin',      email: `safetrack.demo.admin@${DOMAIN}`,     role: 'administrator' },
  treasurer: { name: 'Terry Treasurer', email: `safetrack.demo.treasurer@${DOMAIN}`, role: 'treasurer' },
  teller1:   { name: 'Mary Counter',   email: `safetrack.demo.teller1@${DOMAIN}`,   role: 'teller' },
  teller2:   { name: 'Joe Counter',    email: `safetrack.demo.teller2@${DOMAIN}`,   role: 'teller' },
};

const client = () => createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const must = (r, what) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
const log = (...a) => console.log('•', ...a);

// Deterministic pseudo-random so every demo looks the same
let seed = 20261113;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

async function signIn(p) {
  const c = client();
  must(await c.auth.signInWithPassword({ email: p.email, password: PASSWORD }), `sign in ${p.email}`);
  return c;
}

// ---------------------------------------------------------------------------
const admin = client();
const su = await admin.auth.signUp({ email: people.admin.email, password: PASSWORD, options: { data: { display_name: people.admin.name } } });
if (su.error && !/already/i.test(su.error.message)) throw new Error('sign up: ' + su.error.message);
if (!su.data?.session) must(await admin.auth.signInWithPassword({ email: people.admin.email, password: PASSWORD }), 'admin sign in');

const existing = must(await admin.from('churches').select('id, name'), 'list churches');
if (existing.some(c => c.name === CHURCH)) {
  console.log(`"${CHURCH}" already exists for ${people.admin.email}. Nothing to do.`);
  process.exit(0);
}
const churchId = must(await admin.rpc('create_church', { p_name: CHURCH, p_display_name: people.admin.name }), 'create church');
log('church created:', CHURCH);

// Members (Edge Function, same as User Management)
for (const p of [people.treasurer, people.teller1, people.teller2]) {
  const { error } = await admin.functions.invoke('members', {
    body: { action: 'create', church_id: churchId, email: p.email, display_name: p.name, role: p.role, password: PASSWORD },
  });
  if (error) {
    const body = await error.context?.json?.().catch(() => null);
    if (!/already has a SafeTrack login/.test(body?.error ?? '')) throw new Error(`add ${p.name}: ${body?.error ?? error.message}`);
    log(`${p.name} already has a login (reusing it is not supported for demo seeding); delete it and re-run`);
    process.exit(1);
  }
  log('member added:', p.name, `(${p.role})`);
}

// Settings (logos are original demo artwork in scripts/demo-assets)
const logo = (f) => 'data:image/png;base64,' + fs.readFileSync(new URL(`./demo-assets/${f}`, import.meta.url)).toString('base64');
must(await admin.from('church_settings').update({
  bank_logo: logo('test-bank.png'), church_logo: logo('grace-church.png'),
  account_of: 'Grace Community Church', branch_number: '00123', account_number: '1234567',
  church_address_line1: '123 Main Street', church_address_line2: 'Barrie, ON L4M 1A1', church_address_line3: '(705) 555-0100',
  accounting_recipients: [people.treasurer.email], envelope_recipients: [people.admin.email], deposit_recipients: [people.treasurer.email],
}).eq('church_id', churchId), 'settings');

must(await admin.from('funds').insert({ church_id: churchId, name: 'Roof Appeal', sort_order: 100 }), 'fund');
must(await admin.from('internal_accounts').insert([
  { church_id: churchId, code: 'YOUTH-01' }, { church_id: churchId, code: 'FOODBANK' },
]), 'internal accounts');
const funds = Object.fromEntries(must(await admin.from('funds').select('id, name').eq('church_id', churchId), 'funds').map(f => [f.name, f.id]));
const accts = Object.fromEntries(must(await admin.from('internal_accounts').select('id, code').eq('church_id', churchId), 'accts').map(a => [a.code, a.id]));

// Givers (fictional)
const names = [
  ['Anne Baker', 'David Baker'], ['Carlos Mendes', 'Lucia Mendes'], ['Grace Kim', ''], ['Henry Walsh', 'Ruth Walsh'],
  ['Isabel Nguyen', ''], ['James Okafor', 'Ada Okafor'], ['Karen Liu', ''], ['Liam Doyle', 'Nora Doyle'],
  ['Maria Rossi', ''], ['Noah Patel', 'Priya Patel'], ['Olivia Grant', ''], ['Peter Schmidt', 'Eva Schmidt'],
  ['Quinn Murphy', ''], ['Rachel Cohen', 'Sam Cohen'], ['Simon Brooks', ''], ['Tara Singh', 'Raj Singh'],
  ['Victor Haddad', ''], ['Wendy Chow', 'Alan Chow'], ['Yusuf Ali', ''], ['Zoe Martin', 'Luc Martin'],
];
const givers = must(await admin.from('givers').insert(names.map(([n, n2], i) => ({
  church_id: churchId, name: n, name2: n2 || null,
  email: `${n.split(' ')[0].toLowerCase()}@example.com`,
  etransfer_id: i % 3 === 0 ? `${n.split(' ')[0].toLowerCase()}@example.com` : null,
  address1: `${100 + i * 7} Maple Avenue`, address2: 'Barrie, ON',
}))).select('id, name, envelope_number'), 'givers');
const system = Object.fromEntries(must(await admin.from('givers').select('id, envelope_number').eq('church_id', churchId).eq('is_system', true), 'system givers').map(g => [g.envelope_number, g.id]));
log(`${givers.length} givers registered (envelopes ${givers[0].envelope_number}–${givers.at(-1).envelope_number})`);

// ---------------------------------------------------------------------------
// Batches: tellers enter and finalize with two real sessions
const t1 = await signIn(people.teller1);
const t2 = await signIn(people.teller2);
const DENOMS = [100, 50, 20, 10, 5, 2, 1, 0.25, 0.1, 0.05];

function cashCounts(amount) {
  const counts = {};
  let cents = Math.round(amount * 100);
  for (const d of DENOMS) {
    const dc = Math.round(d * 100);
    const n = Math.floor(cents / dc);
    if (n > 0) { counts[String(d)] = n; cents -= n * dc; }
  }
  return counts;
}

function buildDonations() {
  const rows = [];
  const regulars = [...givers].sort(() => rand() - 0.5).slice(0, 9 + Math.floor(rand() * 5));
  for (const g of regulars) {
    const amount = pick([20, 25, 40, 50, 60, 75, 100, 120, 150, 200, 250]);
    const method = rand() < 0.65 ? 'cheque' : rand() < 0.5 ? 'cash' : 'e_transfer';
    let splits = [{ fund_id: funds.General, amount }];
    if (rand() < 0.25) {
      const part = Math.min(amount - 10, pick([10, 20, 25]));
      splits = [{ fund_id: funds.General, amount: amount - part }, { fund_id: pick([funds.Missions, funds['Roof Appeal'], funds.Benevolent]), amount: part }];
    }
    rows.push({
      giver_id: g.id, amount, payment_method: method,
      cheque_number: method === 'cheque' ? String(1000 + Math.floor(rand() * 8999)) : '',
      cash_counts: method === 'cash' ? cashCounts(amount) : null, splits,
    });
  }
  const loose = Math.round((80 + rand() * 120) * 4) / 4; // to the quarter
  rows.push({ giver_id: system[0], amount: loose, payment_method: 'cash', cash_counts: cashCounts(loose), splits: [{ fund_id: funds.General, amount: loose }] });
  if (rand() < 0.5) rows.push({
    giver_id: system[1], amount: 35, payment_method: 'cash', cash_counts: cashCounts(35),
    splits: [{ fund_id: funds.Internal, internal_account_id: pick([accts['YOUTH-01'], accts.FOODBANK]), amount: 35 }],
  });
  return rows;
}

function auditOf(rows) {
  const cash = {};
  let chequeCount = 0, chequeTotal = 0;
  for (const r of rows) {
    if (r.payment_method === 'cash') for (const [k, v] of Object.entries(r.cash_counts)) cash[k] = (cash[k] || 0) + v;
    if (r.payment_method === 'cheque') { chequeCount++; chequeTotal += r.amount; }
  }
  return { cash, chequeCount, chequeTotal: Math.round(chequeTotal * 100) / 100 };
}

const sundays = ['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01', '2026-11-08'];
for (const [i, date] of sundays.entries()) {
  const rows = buildDonations();
  const saved = must(await t1.rpc('save_batch', {
    p_church_id: churchId, p_batch: { batch_number: `B-${date}`, batch_date: date, source: 'in_person' }, p_donations: rows,
  }), `save ${date}`);
  const total = rows.reduce((s, r) => s + r.amount, 0).toFixed(2);
  if (i === sundays.length - 1) { log(`${date}: $${total} entered, left OPEN for you to audit and finalize`); continue; }

  const a = auditOf(rows);
  must(await t2.rpc('sign_batch', { p_batch_id: saved.batch_id }), `sign ${date}`);
  must(await t1.rpc('finalize_batch', { p_batch_id: saved.batch_id, p_cash_counts: a.cash, p_cheque_count: a.chequeCount, p_cheque_total: a.chequeTotal }), `finalize ${date}`);
  log(`${date}: $${total} finalized by ${people.teller1.name} + ${people.teller2.name}`);

  if (date === '2026-10-25') {
    // A realistic correction: a cheque was keyed $10 low
    must(await admin.rpc('unlock_batch', { p_batch_id: saved.batch_id, p_reason: 'Cheque amount keyed $10 low; corrected against the deposit receipt' }), 'unlock');
    const ids = saved.donation_ids;
    const fixIdx = rows.findIndex(r => r.payment_method === 'cheque' && r.splits.length === 1);
    rows[fixIdx] = { ...rows[fixIdx], amount: rows[fixIdx].amount + 10, splits: [{ fund_id: funds.General, amount: rows[fixIdx].amount + 10 }] };
    must(await admin.rpc('save_batch', {
      p_church_id: churchId, p_batch: { id: saved.batch_id, batch_date: date },
      p_donations: rows.map((r, k) => ({ ...r, id: ids[k] })),
    }), 'adjust');
    const a2 = auditOf(rows);
    must(await admin.rpc('finalize_batch', { p_batch_id: saved.batch_id, p_cash_counts: a2.cash, p_cheque_count: a2.chequeCount, p_cheque_total: a2.chequeTotal }), 're-finalize');
    log(`${date}: unlocked by ${people.admin.name}, corrected (+$10), re-finalized (shows Admin / Adj)`);
  }
}

console.log(`
Demo ready: ${CHURCH}
  Password for every demo login: ${PASSWORD}
  Administrator : ${people.admin.email}
  Treasurer     : ${people.treasurer.email}
  Teller 1      : ${people.teller1.email}
  Teller 2      : ${people.teller2.email}
`);
