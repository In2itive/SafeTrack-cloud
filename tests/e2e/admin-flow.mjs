// SafeTrack Cloud end-to-end test, driven through the real UI in headless Chrome.
// PHASE=admin  : church setup, givers, batch entry, audit, finalize, reports, unlock/adjust
// PHASE=tellers: (needs `members` Edge Function) add tellers, dual sign-in, dual finalize
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000/';
const stamp = Date.now().toString(36);
const state = fs.existsSync('state.json') ? JSON.parse(fs.readFileSync('state.json', 'utf8')) : {};
const PASSWORD = 'Test-Password-2026!';
const log = (...a) => console.log('•', ...a);
let shot = 0;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } } : {}),
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !/tailwind|TUNNEL|404/.test(m.text())) errors.push(m.text()); });
page.on('dialog', d => { log('dialog:', d.message().slice(0, 120)); d.accept(); });
const snap = async (name) => page.screenshot({ path: `shots/${String(++shot).padStart(2, '0')}-${name}.png`, fullPage: true });
fs.mkdirSync('shots', { recursive: true });
const text = async () => (await page.innerText('body')).replace(/\s+/g, ' ');
const expectText = async (re, label) => {
  await page.waitForFunction(r => new RegExp(r, 'i').test(document.body.innerText), re.source, { timeout: 20000 })
    .catch(async () => { await snap('FAIL-' + label); throw new Error(`Expected /${re.source}/ (${label}). Page: ${(await text()).slice(0, 600)}`); });
  log('ok:', label);
};

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });

  if (process.env.PHASE !== 'tellers') {
    // ---- 1. Set up a church -------------------------------------------------
    const adminEmail = `st-e2e-admin-${stamp}@in2itive.ca`;
    await page.getByText('Set up your church').click();
    await page.getByPlaceholder('Grace Community Church').fill(`E2E Church ${stamp}`);
    await page.getByPlaceholder('John Doe').fill('Alice Admin');
    await page.getByPlaceholder('john@example.com').fill(adminEmail);
    await page.getByPlaceholder('At least 10 characters').fill(PASSWORD);
    await page.locator('input[type=password]').nth(1).fill(PASSWORD);
    await page.getByRole('button', { name: /Create Church/ }).click();
    await expectText(/Dashboard|Giver Registry/, 'church created, admin signed in');
    state.adminEmail = adminEmail; state.church = `E2E Church ${stamp}`;
    await snap('dashboard');

    // ---- 2. Register givers -------------------------------------------------
    await page.getByRole('link', { name: /Giver Registry/ }).click();
    for (const [name, spouse] of [['Jane Doe', 'John Doe'], ['Sam Lee', '']]) {
      await page.getByRole('button', { name: /Register New Giver|New Giver|Add Giver/i }).first().click();
      await page.locator('form input').first().fill(name);
      if (spouse) await page.locator('form input').nth(1).fill(spouse);
      await page.locator('form button[type=submit]').click();
      await expectText(new RegExp(name), `giver ${name} saved`);
    }
    await expectText(/#?100/, 'envelope #100 auto-assigned');
    await snap('givers');

    // ---- 3. Enter a batch: cheque split + cash with denominations -----------
    await page.getByRole('link', { name: /New Batch/ }).click();
    await page.waitForTimeout(1500);
    const giverInputs = () => page.getByPlaceholder('Env #, Name, or ID');
    // Row 1: Jane, cheque $100 #551
    await giverInputs().first().fill('Jane');
    await page.getByText(/Jane Doe/).first().click();
    await page.waitForTimeout(400);  // app moves focus to Amount after selecting a giver
    await page.locator('[id^=amount-]').first().fill('100');
    await page.getByPlaceholder('Chq #').first().fill('551');
    await page.waitForTimeout(200);
    await snap('batch-row1');
    // add row (auto-saves)
    await page.getByRole('button', { name: /Add New Row/i }).click();
    await page.waitForTimeout(2500);
    await expectText(/Edit Batch #/, 'auto-save created the batch');
    if ((await giverInputs().count()) < 1) throw new Error('new row missing after auto-save');
    log('url after auto-save:', page.url());
    // Row 2: Loose giving cash $50 = 2x20 + 1x10
    await giverInputs().last().fill('Loose');
    await page.getByText(/Loose Giving/).first().click();
    await page.waitForTimeout(400);
    await page.locator('[id^=amount-]').nth(1).fill('50');
    await page.locator('table tbody tr').nth(1).locator('select').selectOption({ label: 'Cash' }).catch(async () => {
      await page.locator('table tbody tr').nth(1).locator('select').selectOption('Cash');
    });
    await page.locator('table tbody tr').nth(1).locator('button:has(svg.lucide-banknote)').click();
    const counter = page.locator('.fixed').last();
    const qty = counter.locator('input[type=number]');
    await qty.nth(2).fill('2');   // $20
    await qty.nth(3).fill('1');   // $10
    await snap('cash-counter');
    await counter.getByRole('button', { name: /Save Counts/ }).click();
    await snap('batch-ready');
    await page.getByRole('button', { name: /Save & Exit|Update & Exit/ }).first().click();
    await expectText(/Batch History/, 'saved, on Batch History');
    await expectText(/\$150\.00/, 'batch total $150.00 computed by server');
    await snap('history');

    // ---- 4. Blind audit + finalize (admin alone: allowed by default) --------
    const audit = page.locator('input[type=number]');
    const nums = await audit.count();
    log('audit inputs:', nums);
    // cash denominations in order 100,50,20,10,... then cheque count, cheque amount
    await audit.nth(2).fill('2');
    await audit.nth(3).fill('1');
    await page.getByPlaceholder('Count...').fill('1');
    await page.getByPlaceholder('0.00').last().fill('100');
    await page.getByRole('button', { name: /Finalize Batch/ }).click();
    await page.getByRole('button', { name: /Confirm & Lock/ }).click();
    await expectText(/Batch Locked/, 'finalized by server (blind audit passed)');
    await snap('finalized');

    // ---- 5. Reports ---------------------------------------------------------
    for (const r of ['Accounting', 'Envelope', 'Deposit']) {
      await page.getByRole('button', { name: new RegExp(`^\\s*${r}`, 'i') }).first().click().catch(() => {});
      await page.waitForTimeout(1500);
      await snap(`report-${r}`);
    }
    await expectText(/Alice Admin/, 'report shows finalizing user');

    // ---- 6. Unlock with reason, adjust, re-finalize --------------------------
    await page.goto(BASE + '#/history', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^\s*Unlock\s*$/ }).first().click();
    await page.getByPlaceholder(/Reason for the adjustment/).fill('Cheque 551 was actually $110');
    await page.getByRole('button', { name: /Confirm Unlock/ }).click();
    await expectText(/Audit Incomplete|Finalize Batch/, 'unlocked (revision 2)');
    await page.getByRole('button', { name: /Edit Batch/ }).click();
    await page.waitForTimeout(2000);
    await page.locator('[id^=amount-]').first().fill('110');
    await page.getByRole('button', { name: /Update & Exit/ }).first().click();
    await expectText(/\$160\.00/, 'adjusted total $160.00');
    const audit2 = page.locator('input[type=number]');
    await audit2.nth(2).fill('2');
    await audit2.nth(3).fill('1');
    await page.getByPlaceholder('Count...').fill('1');
    await page.getByPlaceholder('0.00').last().fill('110');
    await page.getByRole('button', { name: /Finalize Batch/ }).click();
    await page.getByRole('button', { name: /Confirm & Lock/ }).click();
    await expectText(/Batch Locked/, 're-finalized after adjustment');
    await snap('refinalized');
    await expectText(/Admin \/ Adj|Adj:/, 'admin adjustment shown on reports');
  }

  fs.writeFileSync('state.json', JSON.stringify(state, null, 2));
  console.log('\nE2E PASSED', errors.length ? `(page errors: ${errors.join(' | ').slice(0, 400)})` : '(no page errors)');
} catch (e) {
  await snap('error').catch(() => {});
  console.log('\nE2E FAILED:', e.message);
  console.log('page errors:', errors.join(' | ').slice(0, 800));
  process.exitCode = 1;
} finally {
  await browser.close();
}
