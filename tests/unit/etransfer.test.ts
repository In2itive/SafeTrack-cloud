/** e-Transfer notification parsing. Run: npm run test:unit */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { etransferProvider, envelopeFromMemo, splitPasted } from '../../services/giving/providers/etransfer';
import { buildIndexes, suggestFund, suggestGiver, type MatchContext } from '../../services/giving/matching';
import type { SourceDoc } from '../../services/giving/types';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log(`ok  ${name}`); };
const dir = new URL('../fixtures/etransfer/', import.meta.url);
const doc = (f: string): SourceDoc => ({ name: f, content: readFileSync(new URL(f, dir), 'utf8') });
const one = async (f: string) => {
  const r = await etransferProvider.parseDocuments([doc(f)]);
  assert.equal(r.gifts.length, 1, `${f}: ${JSON.stringify(r.skipped)}`);
  return { gift: r.gifts[0], warnings: r.warnings };
};

await test('envelope numbers in memos', () => {
  assert.equal(envelopeFromMemo('Tithe - env 100'), 100);
  assert.equal(envelopeFromMemo('Envelope #45 general'), 45);
  assert.equal(envelopeFromMemo('Enveloppe no 205'), 205);
  assert.equal(envelopeFromMemo('ENV#7'), 7);
  assert.equal(envelopeFromMemo('101'), 101);
  assert.equal(envelopeFromMemo('Building fund 2026'), undefined);
  assert.equal(envelopeFromMemo('Missions'), undefined);
});

await test('Autodeposit email (.eml, quoted-printable)', async () => {
  const { gift, warnings } = await one('autodeposit.eml');
  assert.deepEqual(
    [gift.externalId, gift.giftDate, gift.amount, gift.payerName, gift.payerEmail, gift.memo, gift.payerEnvelope, gift.method, gift.fee],
    ['C1AbCdEf2GhI', '2026-11-08', 1100, 'John Smith', 'john.smith@example.com', 'Tithe - env 100', 100, 'e_transfer', 0]);
  assert.equal(gift.payerExternalId, 'john.smith@example.com');
  assert.equal(warnings.length, 0);
});

await test('HTML-only email, label on its own line, encoded subject', async () => {
  const { gift } = await one('html-only.eml');
  assert.deepEqual([gift.externalId, gift.amount, gift.payerName, gift.payerEmail, gift.memo, gift.giftDate],
    ['CA9ZyXwVuT87', 75, 'Sam Lee', 'sam.lee@example.com', 'Missions', '2026-11-09']);
});

await test('Forwarded email uses the original date and sender', async () => {
  const { gift, warnings } = await one('forwarded.eml');
  assert.deepEqual([gift.externalId, gift.amount, gift.payerName, gift.payerEmail, gift.memo, gift.giftDate],
    ['CAQWERTY1234', 40, 'Ann Nguyen', 'ann@example.com', 'Building fund', '2026-11-08']);
  assert.equal(warnings.length, 0);
});

await test('French notification', async () => {
  const { gift } = await one('french.eml');
  assert.deepEqual([gift.externalId, gift.amount, gift.payerName, gift.payerEmail, gift.payerEnvelope],
    ['CAFRENCH0001', 1250.5, 'Marie Tremblay', 'marie@example.com', 205]);
});

await test('Money requests are skipped', async () => {
  const r = await etransferProvider.parseDocuments([doc('request.eml')]);
  assert.equal(r.gifts.length, 0);
  assert.match(r.skipped[0].reason, /Not a deposit/);
});

await test('Pasted text with two emails', async () => {
  const text = readFileSync(new URL('pasted.txt', dir), 'utf8');
  assert.equal(splitPasted(text).length, 2);
  const r = await etransferProvider.parseDocuments([{ name: 'Pasted text', content: text }]);
  assert.deepEqual(r.gifts.map(g => [g.externalId, g.amount, g.payerName, g.giftDate, g.payerEnvelope ?? null]),
    [['CAPASTE00001', 25, 'Pat Kim', '2026-11-15', null], ['CAPASTE00002', 30, 'Lee Wong', '2026-11-15', 101]]);
  assert.ok(r.warnings.length === 0 || r.warnings.every(w => !/reference/.test(w)));
});

await test('mbox with two messages; duplicates in one upload are dropped', async () => {
  const r = await etransferProvider.parseDocuments([doc('inbox.mbox'), doc('autodeposit.eml')]);
  assert.deepEqual(r.gifts.map(g => g.externalId), ['C1AbCdEf2GhI', 'CAQWERTY1234']);
  assert.equal(r.skipped.filter(s => /twice/.test(s.reason)).length, 1);
});

await test('Whole folder at once', async () => {
  const files = readdirSync(dir).filter(f => /\.(eml|txt)$/.test(f));
  const r = await etransferProvider.parseDocuments(files.map(doc));
  assert.equal(r.gifts.length, 6);
  assert.equal(r.skipped.length, 1);
});

await test('Matching: e-Transfer ID / envelope / memo fund', async () => {
  const r = await etransferProvider.parseDocuments(['autodeposit.eml', 'html-only.eml', 'forwarded.eml', 'french.eml'].map(doc));
  const ctx: MatchContext = {
    givers: [
      { id: 'g100', envelopeNumber: 100, name: 'Smith, John' },
      { id: 'g101', envelopeNumber: 101, name: 'Sam Lee', eTransferId: 'SAM.LEE@example.com' },
      { id: 'g102', envelopeNumber: 102, name: 'Ann Nguyen' },
    ],
    giverLinks: new Map(),
    funds: ['General', 'Missions', 'Building', 'Internal'].map(n => ({ id: `f-${n}`, name: n, isSystem: true, isActive: true })),
    fundMap: new Map(),
  };
  const idx = buildIndexes(ctx);
  assert.deepEqual(r.gifts.map(g => { const s = suggestGiver(g, ctx, idx); return `${s.giverId ?? '-'}:${s.reason ?? '-'}`; }),
    ['g100:envelope', 'g101:email', 'g102:name', '-:-']);
  assert.deepEqual(r.gifts.map(g => { const s = suggestFund(g, ctx); return `${s.fundId ?? '-'}:${s.reason ?? '-'}`; }),
    ['f-General:guess', 'f-Missions:memo', 'f-Building:memo', 'f-General:guess']);
});

console.log(`\n${passed} e-Transfer tests passed`);
