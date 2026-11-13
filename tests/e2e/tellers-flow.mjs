// Phase 2: members, two-teller sign-in, server-enforced dual control, legacy import.
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000/';
const URL_ = 'https://itugzzvugoohsiedfioi.supabase.co';
const KEY = 'sb_publishable_UiR2Tr3OhhcSUhGDRzns8Q_HpheIdVE';
const PASSWORD = 'Test-Password-2026!';
const state = JSON.parse(fs.readFileSync('tests/e2e/state.json', 'utf8'));
const stamp = Date.now().toString(36);
const tina = { name: 'Tina Teller', email: `st-e2e-tina-${stamp}@in2itive.ca` };
const tom = { name: 'Tom Teller', email: `st-e2e-tom-${stamp}@in2itive.ca` };
const log = (...a) => console.log('•', ...a);
let shot = 20;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } } : {}),
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => { log('dialog:', d.message().replace(/\s+/g, ' ').slice(0, 200)); d.accept(); });
const snap = (n) => page.screenshot({ path: `shots/${++shot}-${n}.png`, fullPage: true });
const text = async () => (await page.innerText('body')).replace(/\s+/g, ' ');
const expectText = async (re, label) => {
  await page.waitForFunction(r => new RegExp(r, 'i').test(document.body.innerText), re.source, { timeout: 20000 })
    .catch(async () => { await snap('FAIL'); throw new Error(`Expected /${re.source}/ (${label}). Page: ${(await text()).slice(0, 700)}`); });
  log('ok:', label);
};
const signIn = async (email) => {
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
};

try {
  // ---- 1. Admin adds two tellers through User Management (Edge Function) ----
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await signIn(state.adminEmail);
  await expectText(/Logged in as/, 'admin signed in');
  await page.getByRole('link', { name: /User Management/ }).click();
  await expectText(/Alice Admin/, 'member list loaded from Edge Function');
  for (const t of [tina, tom]) {
    await page.getByRole('button', { name: /Add New User/ }).click();
    const form = page.locator('form');
    await form.locator('input[type=text]').first().fill(t.name);
    await form.locator('input[type=email]').fill(t.email);
    await form.locator('select').selectOption({ index: 0 }).catch(() => {});
    await form.locator('select').selectOption('Teller').catch(() => {});
    await form.locator('input[type=password]').fill(PASSWORD);
    await form.getByRole('button', { name: /Save User/ }).click();
    await expectText(new RegExp(t.name), `${t.name} created`);
  }
  await snap('members');
  await page.getByRole('button', { name: /Lock Vault/ }).click();

  // ---- 2. Server refuses a lone teller (bypassing the UI entirely) ----------
  const solo = createClient(URL_, KEY, { auth: { persistSession: false } });
  await solo.auth.signInWithPassword({ email: tina.email, password: PASSWORD });

  // ---- 3. Tina signs in, app demands a second teller; Tom signs in ----------
  await expectText(/Sign in|Email/, 'locked');
  await signIn(tina.email);
  await expectText(/Second Teller/, 'non-admin is asked for a second teller');
  await snap('second-teller-prompt');
  await signIn(tina.email);
  await expectText(/must be a different person/, 'same person as second teller is refused');
  await signIn(tom.email);
  await expectText(/Tom Teller/, 'both tellers signed in');
  await snap('two-tellers');

  // ---- 4. Tellers enter + finalize a batch ----------------------------------
  await page.getByRole('link', { name: /New Batch/ }).click();
  await page.waitForTimeout(1500);
  await page.getByPlaceholder('Env #, Name, or ID').first().fill('Sam');
  await page.getByText(/Sam Lee/).first().click();
  await page.waitForTimeout(400);
  await page.locator('[id^=amount-]').first().fill('40');
  await page.getByPlaceholder('Chq #').first().fill('777');
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: /Save & Exit/ }).first().click();
  await page.waitForURL(/#\/history/, { timeout: 20000 });
  await expectText(/Audit Incomplete|Finalize Batch|Physical Cheques|Count\.\.\./, 'teller batch saved, audit screen open');

  // Lone-teller attempt straight against the API: must be refused by the database
  const { error: signErr } = await solo.auth.getSession();
  if (signErr) throw signErr;
  const { data: open, error: openErr } = await solo.from('batches').select('id').eq('status', 'open').order('created_at', { ascending: false }).limit(1);
  if (openErr || !open?.length) throw new Error('could not see the open batch as Tina: ' + (openErr?.message ?? 'none found'));
  const { error: soloErr } = await solo.rpc('finalize_batch', { p_batch_id: open[0].id, p_cash_counts: {}, p_cheque_count: 1, p_cheque_total: 40 });
  if (!soloErr || !/Two different tellers/.test(soloErr.message)) throw new Error('lone teller was NOT refused: ' + (soloErr?.message ?? 'finalized!'));
  log('ok: database refused a lone teller calling finalize_batch directly ->', soloErr.message);

  await page.getByPlaceholder('Count...').fill('1');
  await page.getByPlaceholder('0.00').last().fill('40');
  await page.getByRole('button', { name: /Finalize Batch/ }).click();
  await page.getByRole('button', { name: /Confirm & Lock/ }).click();
  await expectText(/Batch Locked/, 'two tellers finalized (second teller signed with own session)');
  const { data: so } = await solo.from('batch_signoffs').select('display_name').eq('batch_id', open[0].id);
  const names = so.map(s => s.display_name).sort().join(' + ');
  if (names !== 'Tina Teller + Tom Teller') throw new Error('unexpected sign-offs: ' + names);
  log('ok: sign-offs recorded in database:', names);

  // Teller can't unlock (no button) and the API refuses too
  const { error: unlockErr } = await solo.rpc('unlock_batch', { p_batch_id: open[0].id, p_reason: 'sneaky' });
  if (!unlockErr) throw new Error('teller was able to unlock!');
  log('ok: teller unlock refused by database ->', unlockErr.message);
  await page.getByRole('button', { name: /Deposit Slip/ }).first().click();
  await expectText(/Tina Teller/, 'deposit slip shows Tina');
  await expectText(/Tom Teller/, 'deposit slip shows Tom');
  await snap('deposit-two-tellers');
  await page.goto(BASE + '#/history');
  await page.getByRole('button', { name: /Lock Vault/ }).click();

  // ---- 5. Import an offline-SafeTrack backup into a brand-new church --------
  await expectText(/Set up your church/, 'locked');
  await page.getByText('Set up your church').click();
  await page.getByPlaceholder('Grace Community Church').fill(`Import Church ${stamp}`);
  await page.getByPlaceholder('John Doe').fill('Ian Importer');
  await page.getByPlaceholder('john@example.com').fill(`st-e2e-import-${stamp}@in2itive.ca`);
  await page.getByPlaceholder('At least 10 characters').fill(PASSWORD);
  await page.locator('input[type=password]').nth(1).fill(PASSWORD);
  await page.getByRole('button', { name: /Create Church/ }).click();
  await expectText(/Logged in as/, 'import church created');
  await page.getByRole('link', { name: /Admin \/ Backup/ }).click();
  await page.waitForTimeout(1500);
  const dialogs = [];
  page.on('dialog', d => dialogs.push(d.message()));
  await page.locator('input[type=file][accept*=json]').setInputFiles('supabase/tests/legacy_backup_sample.json');
  await page.getByRole('button', { name: /^\s*Proceed\s*$/ }).click();
  await expectText(/Imported 3 givers, 2 batches \(1 finalized\) and 3 donations/, 'legacy backup imported through the UI');
  await snap('import-result');
  await page.getByRole('button', { name: /^\s*OK\s*$/ }).first().click().catch(() => {});
  await page.getByRole('link', { name: /Batch History/ }).click();
  await expectText(/\$170\.00/, 'imported finalized batch total');
  await snap('imported-history');
  await page.getByRole('link', { name: /Giver Registry/ }).click();
  await expectText(/Jane Doe/, 'imported givers visible');

  console.log('\nTELLER + IMPORT E2E PASSED', errors.length ? `(page errors: ${errors.join(' | ').slice(0, 300)})` : '(no page errors)');
} catch (e) {
  await snap('error').catch(() => {});
  console.log('\nE2E FAILED:', e.message);
  console.log('page errors:', errors.join(' | ').slice(0, 600));
  process.exitCode = 1;
} finally {
  await browser.close();
}
