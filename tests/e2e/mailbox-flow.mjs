// Mailbox intake screens: set up an IMAP mailbox (password write-only),
// test connection / check now report errors, and a flagged e-Transfer can't
// be posted until someone ticks "Reviewed". The raw memo is shown exactly.
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000/';
const stamp = Date.now().toString(36);
const PASSWORD = 'Test-Password-2026!';
const DIR = 'tests/fixtures/etransfer/';
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
const snap = async (name) => page.screenshot({ path: `shots/mailbox-${String(++shot).padStart(2, '0')}-${name}.png`, fullPage: true });
const expectText = async (re, label) => {
  await page.waitForFunction(r => new RegExp(r, 'i').test(document.body.innerText), re.source, { timeout: 20000 })
    .catch(async () => { await snap('FAIL'); throw new Error(`Expected /${re.source}/ (${label}). Page: ${(await page.innerText('body')).replace(/\s+/g, ' ').slice(0, 800)}`); });
  log('ok:', label);
};

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByText('Set up your church').click();
  await page.getByPlaceholder('Grace Community Church').fill(`E2E Mailbox ${stamp}`);
  await page.getByPlaceholder('John Doe').fill('Alice Admin');
  await page.getByPlaceholder('john@example.com').fill(`st-e2e-mailbox-${stamp}@in2itive.ca`);
  await page.getByPlaceholder('At least 10 characters').fill(PASSWORD);
  await page.locator('input[type=password]').nth(1).fill(PASSWORD);
  await page.getByRole('button', { name: /Create Church/ }).click();
  await expectText(/Dashboard|Giver Registry/, 'church created');

  await page.getByRole('link', { name: /Online Giving/ }).click();
  await page.getByRole('button', { name: /^e-Transfer$/ }).click();
  await expectText(/Automatic intake from the giving mailbox/, 'mailbox panel');
  const panel = page.getByTestId('mailbox-panel');
  await panel.getByRole('button', { name: /^Set up$/ }).click();
  await panel.getByPlaceholder('mail.yourchurch.ca').fill('imap.does-not-exist.invalid');
  await panel.getByPlaceholder('giving@yourchurch.ca').fill('giving@yourchurch.ca');
  await panel.locator('input[type=password]').fill('app-password-123');
  await panel.getByRole('button', { name: /^\s*Save$/ }).click();
  await expectText(/Saved\./, 'settings saved');
  await expectText(/IMAP \(giving@yourchurch\.ca@imap\.does-not-exist\.invalid\)/, 'summary shows the mailbox');
  {
    const pw = panel.locator('input[type=password]');
    if ((await pw.inputValue()) !== '' || !/Saved — leave blank to keep/.test(await pw.getAttribute('placeholder') ?? ''))
      throw new Error('password field should be empty with a "Saved" placeholder');
    log('ok: password is write-only (not shown back)');
  }
  await panel.getByRole('button', { name: /Test connection/ }).click();
  await expectText(/ENOTFOUND|getaddrinfo|dns|lookup|failed|resolve/i, 'test connection reports the server error');
  await snap('settings');
  await panel.getByRole('button', { name: /Check now/ }).click();
  await expectText(/Last check failed/, 'check now records the failure');

  // a suspicious email uploaded by hand: flagged, needs Reviewed before posting
  await page.getByTestId('giving-files').setInputFiles([DIR + 'suspicious.eml']);
  await expectText(/flagged for review/, 'upload preview warns');
  await page.getByRole('button', { name: /Add 1 gift for review/ }).click();
  await expectText(/1 new gift added for review/, 'staged');
  await expectText(/Sender isn't Interac/, 'not-from-Interac flag shown on the gift');
  await expectText(/No Interac reference number/, 'no-reference flag shown');
  await expectText(/“Missions”/, 'memo shown exactly');
  await expectText(/1 gift waiting · 0 ready to post/, 'flagged gift not ready');
  await page.getByRole('button', { name: /Add 1 new giver/ }).click();
  await expectText(/1 gift waiting · 0 ready to post/, 'still not ready after matching (needs review)');
  await page.getByTestId('reviewed').check();
  await expectText(/1 gift waiting · 1 ready to post/, 'ready once reviewed');
  await snap('flagged');

  if (errors.filter(e => !/FunctionsHttpError|non-2xx|Failed to load resource/.test(e)).length)
    throw new Error('Browser errors:\n' + errors.join('\n'));
  log('MAILBOX FLOW PASSED');
} catch (e) {
  console.error('✗', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
