// e-Transfer giving end to end: upload notification emails (.eml), paste
// more, review (envelope / name / memo-fund matching, add a new giver),
// post weekly batches, reconcile, finalize, re-upload is a no-op.
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000/';
const stamp = Date.now().toString(36);
const PASSWORD = 'Test-Password-2026!';
const DIR = 'tests/fixtures/etransfer/';
const EMAILS = ['autodeposit.eml', 'html-only.eml', 'forwarded.eml', 'french.eml', 'request.eml'].map(f => DIR + f);
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
const snap = async (name) => page.screenshot({ path: `shots/etransfer-${String(++shot).padStart(2, '0')}-${name}.png`, fullPage: true });
const expectText = async (re, label) => {
  await page.waitForFunction(r => new RegExp(r, 'i').test(document.body.innerText), re.source, { timeout: 20000 })
    .catch(async () => { await snap('FAIL'); throw new Error(`Expected /${re.source}/ (${label}). Page: ${(await page.innerText('body')).replace(/\s+/g, ' ').slice(0, 800)}`); });
  log('ok:', label);
};

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });

  await page.getByText('Set up your church').click();
  await page.getByPlaceholder('Grace Community Church').fill(`E2E eTransfer ${stamp}`);
  await page.getByPlaceholder('John Doe').fill('Alice Admin');
  await page.getByPlaceholder('john@example.com').fill(`st-e2e-etransfer-${stamp}@in2itive.ca`);
  await page.getByPlaceholder('At least 10 characters').fill(PASSWORD);
  await page.locator('input[type=password]').nth(1).fill(PASSWORD);
  await page.getByRole('button', { name: /Create Church/ }).click();
  await expectText(/Dashboard|Giver Registry/, 'church created');

  await page.getByRole('link', { name: /Giver Registry/ }).click();
  for (const name of ['Smith, John', 'Sam Lee', 'Ann Nguyen']) {
    await page.getByRole('button', { name: /Register New Giver|New Giver|Add Giver/i }).first().click();
    await page.locator('form input').first().fill(name);
    await page.locator('form button[type=submit]').click();
    await expectText(new RegExp(name), `giver ${name}`);
  }

  // ---- upload emails ----
  await page.getByRole('link', { name: /Online Giving/ }).click();
  await page.getByRole('button', { name: /^e-Transfer$/ }).click();
  await expectText(/Upload e-Transfer emails/, 'e-Transfer tab');
  await page.getByTestId('giving-files').setInputFiles(EMAILS);
  await expectText(/Add 4 gifts for review/, '4 e-Transfers read, request skipped');
  await snap('preview');
  await page.getByRole('button', { name: /Add 4 gifts for review/ }).click();
  await expectText(/4 new gifts added for review/, 'staged');

  // ---- review ----
  await expectText(/1 payer is not in the Giver Registry/, 'one unknown payer (Marie)');
  await page.getByRole('button', { name: /Add 1 new giver/ }).click();
  await expectText(/1 giver added to the registry/, 'new giver added');
  await expectText(/4 gifts waiting · 4 ready to post/, 'all 4 ready (envelope, email/name, memo funds)');
  const groups = page.getByTestId('giving-group');
  if ((await groups.count()) !== 2) throw new Error(`expected 2 weekly groups, got ${await groups.count()}`);
  await expectText(/Week ending 11\/8\/2026/, 'grouped by week (ending Sunday)');
  await snap('review');
  await page.getByRole('button', { name: /Select all/ }).click();
  await page.getByTestId('post-batches').click();
  await expectText(/Created batches #\d{8} \(3 gifts, \$2,390\.50\), #\d{8} \(1 gifts, \$75\.00\)/, 'posted two weekly batches');

  // ---- paste two more ----
  await page.getByTestId('giving-paste').fill(fs.readFileSync(DIR + 'pasted.txt', 'utf8'));
  await page.getByRole('button', { name: /Read pasted emails/ }).click();
  await page.getByRole('button', { name: /Add 2 gifts for review/ }).click();
  await expectText(/2 new gifts added for review/, 'pasted emails staged');
  await expectText(/2 gifts waiting/, 'pasted gifts in queue');

  // ---- history ----
  await page.getByRole('link', { name: /Batch History/ }).first().click();
  await page.getByText('$2390.50').first().click();
  await expectText(/E-Transfer reconciliation/, 'reconciliation panel');
  await expectText(/e-Transfer deposits on the bank statement/, 'e-Transfer wording');
  await snap('reconcile');
  await page.getByRole('button', { name: /Finalize Batch/ }).click();
  await page.getByRole('button', { name: /Confirm & Lock/ }).click();
  await expectText(/Batch Locked/, 'e-Transfer batch finalized');

  // ---- registry learned ----
  await page.getByRole('link', { name: /Giver Registry/ }).click();
  await expectText(/Marie Tremblay/, 'Marie in registry');
  await expectText(/205/, 'kept her envelope #205 from the memo');

  // ---- re-upload: nothing new ----
  await page.getByRole('link', { name: /Online Giving/ }).click();
  await page.getByRole('button', { name: /^e-Transfer$/ }).click();
  await page.getByTestId('giving-files').setInputFiles(EMAILS);
  await page.getByRole('button', { name: /Add 4 gifts for review/ }).click();
  await expectText(/0 new gifts added for review, 4 already posted/, 're-upload is a no-op');

  if (errors.length) throw new Error('Browser errors:\n' + errors.join('\n'));
  log('E-TRANSFER FLOW PASSED');
} catch (e) {
  console.error('✗', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
