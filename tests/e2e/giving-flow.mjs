// Online giving end to end, through the real UI: new church → givers →
// upload the Pushpay envelope report → review → post batches → reconcile →
// finalize → re-upload is a no-op.
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000/';
const stamp = Date.now().toString(36);
const PASSWORD = 'Test-Password-2026!';
const FIXTURE = 'tests/fixtures/pushpay-envelope.csv';
const log = (...a) => console.log('•', ...a);
let shot = 0;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } } : {}),
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !/TUNNEL|404/.test(m.text())) errors.push(m.text()); });
page.on('dialog', d => d.accept());
fs.mkdirSync('shots', { recursive: true });
const snap = async (name) => page.screenshot({ path: `shots/giving-${String(++shot).padStart(2, '0')}-${name}.png`, fullPage: true });
const expectText = async (re, label) => {
  await page.waitForFunction(r => new RegExp(r, 'i').test(document.body.innerText), re.source, { timeout: 20000 })
    .catch(async () => { await snap('FAIL'); throw new Error(`Expected /${re.source}/ (${label}). Page: ${(await page.innerText('body')).replace(/\s+/g, ' ').slice(0, 800)}`); });
  log('ok:', label);
};

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });

  // ---- church + two givers (envelopes 100 and 101) ----
  await page.getByText('Set up your church').click();
  await page.getByPlaceholder('Grace Community Church').fill(`E2E Giving ${stamp}`);
  await page.getByPlaceholder('John Doe').fill('Alice Admin');
  await page.getByPlaceholder('john@example.com').fill(`st-e2e-giving-${stamp}@in2itive.ca`);
  await page.getByPlaceholder('At least 10 characters').fill(PASSWORD);
  await page.locator('input[type=password]').nth(1).fill(PASSWORD);
  await page.getByRole('button', { name: /Create Church/ }).click();
  await expectText(/Dashboard|Giver Registry/, 'church created');

  await page.getByRole('link', { name: /Giver Registry/ }).click();
  for (const name of ['Mary Jones', 'Sam Lee']) {
    await page.getByRole('button', { name: /Register New Giver|New Giver|Add Giver/i }).first().click();
    await page.locator('form input').first().fill(name);
    await page.locator('form button[type=submit]').click();
    await expectText(new RegExp(name), `giver ${name}`);
  }

  // ---- upload ----
  await page.getByRole('link', { name: /Online Giving/ }).click();
  await expectText(/Upload a Pushpay export/, 'Online Giving screen');
  await page.getByTestId('giving-file').setInputFiles(FIXTURE);
  await expectText(/Add 5 gifts for review/, 'preview: 5 online gifts');
  await snap('preview');
  await page.getByRole('button', { name: /Add 5 gifts for review/ }).click();
  await expectText(/5 new gifts added for review/, 'staged 5 gifts');

  // ---- review ----
  await expectText(/5 gifts waiting/, 'queue shows 5');
  const groups = page.getByTestId('giving-group');
  if ((await groups.count()) !== 2) throw new Error(`expected 2 date groups, got ${await groups.count()}`);
  await expectText(/ENVELOPE/, 'envelope matches shown');
  await snap('review');

  // blank-envelope gift (M2N4BX) -> pick Sam Lee; envelope 999 -> ignore
  const rowFor = (t) => page.locator('tr', { hasText: t });
  await rowFor('M2N4BX').getByTestId('giver-select').selectOption({ label: 'Sam Lee (#101)' });
  await rowFor('Envelope #999').getByTitle(/Ignore this gift/).click();
  await expectText(/4 gifts waiting · 4 ready to post/, 'all remaining gifts ready');

  await page.getByRole('button', { name: /Select all/ }).click();
  await page.getByTestId('post-batches').click();
  await expectText(/Created batches #\d{8} \(2 gifts, \$300\.00\), #\d{8} \(2 gifts, \$65\.00\)/, 'posted two batches');
  await snap('posted');

  // ---- history: reconciliation + finalize ----
  await page.getByRole('link', { name: /Batch History/ }).first().click();
  await page.getByText('$65.00').first().click();
  await expectText(/PushPay reconciliation/, 'reconciliation panel');
  await expectText(/Expected bank deposit/, 'expected deposit shown');
  await snap('reconcile');
  await page.getByRole('button', { name: /Finalize Batch/ }).click();
  await page.getByRole('button', { name: /Confirm & Lock/ }).click();
  await expectText(/Batch Locked/, 'Pushpay batch finalized (admin solo)');

  // ---- re-upload: nothing new ----
  await page.getByRole('link', { name: /Online Giving/ }).click();
  await page.getByTestId('giving-file').setInputFiles(FIXTURE);
  await page.getByRole('button', { name: /Add 5 gifts for review/ }).click();
  await expectText(/0 new gifts added for review, 4 already posted/, 're-import is a no-op');
  await expectText(/0 gifts waiting|Nothing waiting/, 'queue empty (ignored gift hidden)');
  await snap('reimport');

  if (errors.length) throw new Error('Browser errors:\n' + errors.join('\n'));
  log('GIVING FLOW PASSED');
} catch (e) {
  console.error('✗', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
