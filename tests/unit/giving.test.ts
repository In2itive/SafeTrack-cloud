/**
 * Unit tests for the provider-agnostic giving layer and the Pushpay adapter.
 * Run: npm run test:unit
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAmount, parseCsv, parseDate, detectDateOrder } from '../../services/giving/parse';
import { pushpayProvider, classifyMethod, classifyStatus } from '../../services/giving/providers/pushpay';
import { buildIndexes, nameKeys, suggestFund, suggestGiver, type MatchContext } from '../../services/giving/matching';

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`ok  ${name}`); };

test('CSV: quotes, embedded commas/newlines, BOM, CRLF', () => {
  const t = parseCsv('﻿a,b,c\r\n1,"x, y","multi\nline"\r\n2,"say ""hi""",\r\n\r\n');
  assert.deepEqual(t.headers, ['a', 'b', 'c']);
  assert.deepEqual(t.rows, [['1', 'x, y', 'multi\nline'], ['2', 'say "hi"', '']]);
  assert.equal(t.firstDataLine, 2);
});

test('CSV: title row before the header is skipped', () => {
  const t = parseCsv('Pushpay export\nDate,Amount,Name\n1/1/2026,5,Al\n');
  assert.deepEqual(t.headers, ['Date', 'Amount', 'Name']);
  assert.equal(t.rows.length, 1);
});

test('amounts', () => {
  assert.equal(parseAmount('$1,234.56'), 1234.56);
  assert.equal(parseAmount('(25.00)'), -25);
  assert.equal(parseAmount('-3.5'), -3.5);
  assert.equal(parseAmount('12.00 CAD'), 12);
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.ok(Number.isNaN(parseAmount('abc')));
});

test('dates', () => {
  assert.equal(parseDate('2026-11-08T10:00:00Z', 'mdy'), '2026-11-08');
  assert.equal(parseDate('11/08/2026 09:14', 'mdy'), '2026-11-08');
  assert.equal(parseDate('08/11/2026', 'dmy'), '2026-11-08');
  assert.equal(parseDate('Nov 8, 2026', 'mdy'), '2026-11-08');
  assert.equal(parseDate('Sunday, November 8, 2026', 'mdy'), '2026-11-08');
  assert.equal(parseDate('8 Nov 2026', 'mdy'), '2026-11-08');
  assert.equal(parseDate('02/30/2026', 'mdy'), null);
  assert.equal(detectDateOrder(['23/11/2026', '01/02/2026']), 'dmy');
  assert.equal(detectDateOrder(['11/23/2026']), 'mdy');
});

test('method + status classification', () => {
  assert.equal(classifyMethod('Visa'), 'card');
  assert.equal(classifyMethod('Debit Card'), 'card');
  assert.equal(classifyMethod('Apple Pay'), 'card');
  assert.equal(classifyMethod('ACH'), 'bank_debit');
  assert.equal(classifyMethod('Bank Account'), 'bank_debit');
  assert.equal(classifyMethod('Recorded ACH'), 'offline');
  assert.equal(classifyMethod('Check'), 'offline');
  assert.equal(classifyMethod('Cash'), 'offline');
  assert.equal(classifyMethod(''), 'online');
  assert.equal(classifyStatus('Success'), 'succeeded');
  assert.equal(classifyStatus('Processing'), 'pending');
  assert.equal(classifyStatus('Failed'), 'failed');
  assert.equal(classifyStatus('Refunded'), 'refunded');
});

const sample = parseCsv(readFileSync(new URL('../fixtures/pushpay-sample.csv', import.meta.url), 'utf8'));
const mapping = pushpayProvider.detectMapping(sample.headers);

test('Pushpay: columns detected from the export headers', () => {
  for (const k of ['externalId', 'date', 'status', 'payerId', 'firstName', 'lastName', 'email', 'phone', 'amount', 'fee',
                   'fundCode', 'fundName', 'method', 'source', 'memo', 'depositRef', 'address', 'city', 'region', 'postal', 'country'])
    assert.notEqual(mapping[k], undefined, `field ${k} not detected`);
  assert.equal(pushpayProvider.missingFields(mapping).length, 0);
});

const result = pushpayProvider.parse(sample, mapping, { dateOrder: 'auto' });

test('Pushpay: online gifts kept, offline/failed/refund rows skipped with reasons', () => {
  assert.deepEqual(result.gifts.map(g => g.externalId), ['PP-1001', 'PP-1002', 'PP-1006', 'PP-1007']);
  const reasons = result.skipped.map(s => `${s.line}:${s.reason.split(' ')[0]}`);
  assert.deepEqual(reasons, ['4:Failed', '5:Recorded', '6:Refund']);
});

test('Pushpay: gift fields normalised', () => {
  const g = result.gifts[0];
  assert.equal(g.giftDate, '2026-11-01');
  assert.equal(g.amount, 1000);
  assert.equal(g.fee, 22.3);
  assert.equal(g.method, 'card');
  assert.equal(g.status, 'succeeded');
  assert.equal(g.payerName, 'Mary Jones');
  assert.equal(g.payerExternalId, 'P-501');
  assert.equal(g.fundKey, 'GEN');
  assert.equal(g.fundName, 'Tithes & Offerings');
  assert.equal(g.depositRef, 'B-77');
  assert.equal(g.memo, 'Thanks, Pastor');
  assert.equal(g.payerAddress, '12 Elm St, Apt 3, Barrie, ON, L4M 1A1, Canada');
  assert.equal(result.gifts[1].method, 'bank_debit');
  assert.equal(result.gifts[2].status, 'pending');
  assert.equal(result.gifts[3].fundKey, undefined);
});

test('Pushpay: no Payment ID column -> stable synthetic ids, duplicates numbered', () => {
  const csv = 'Date,Name,Amount,Fund\n2026-11-01,Al Smith,10,General\n2026-11-01,Al Smith,10,General\n';
  const t = parseCsv(csv);
  const m = pushpayProvider.detectMapping(t.headers);
  const a = pushpayProvider.parse(t, m, { dateOrder: 'auto' });
  const b = pushpayProvider.parse(parseCsv(csv), m, { dateOrder: 'auto' });
  assert.equal(a.gifts.length, 2);
  assert.notEqual(a.gifts[0].externalId, a.gifts[1].externalId);
  assert.deepEqual(a.gifts.map(g => g.externalId), b.gifts.map(g => g.externalId));
  assert.ok(a.warnings.some(w => w.includes('No Payment ID')));
});

test('Pushpay: required fields reported when headers are unknown', () => {
  const t = parseCsv('When,How much,Who\n1/1/2026,5,Al\n');
  const m = pushpayProvider.detectMapping(t.headers);
  assert.deepEqual(pushpayProvider.missingFields(m).map(f => f.key).sort(), ['amount', 'date', 'payerName']);
});

test('matching: name variants', () => {
  assert.ok(nameKeys('Smith, John').includes('john smith'));
  const joint = nameKeys('John & Mary Smith');
  assert.ok(joint.includes('john smith') && joint.includes('mary smith'));
});

test('matching: remembered link > provider id > email > unique name; ambiguous names not guessed', () => {
  const ctx: MatchContext = {
    givers: [
      { id: 'g1', envelopeNumber: 100, name: 'Mary Jones', email: 'mary.jones@example.com' },
      { id: 'g2', envelopeNumber: 101, name: 'Lee, Sam' },
      { id: 'g3', envelopeNumber: 102, name: 'Ann Nguyen' },
      { id: 'g4', envelopeNumber: 103, name: 'Ann Nguyen' },
      { id: 'g5', envelopeNumber: 104, name: 'Joe Black', pushPayId: 'joe@example.com' },
    ],
    giverLinks: new Map([['P-502', 'g2']]),
    funds: [{ id: 'f-gen', name: 'General', isSystem: true, isActive: true }, { id: 'f-mis', name: 'Missions', isSystem: true, isActive: true }],
    fundMap: new Map([['bld', 'f-mis']]),
  };
  const idx = buildIndexes(ctx);
  const [mary, sam, ann, joe] = result.gifts;
  assert.deepEqual(suggestGiver(mary, ctx, idx), { giverId: 'g1', reason: 'email' });
  assert.deepEqual(suggestGiver(sam, ctx, idx), { giverId: 'g2', reason: 'remembered' });
  assert.deepEqual(suggestGiver(ann, ctx, idx).candidates?.sort(), ['g3', 'g4']);
  assert.deepEqual(suggestGiver(joe, ctx, idx), { giverId: 'g5', reason: 'provider id' });
  assert.deepEqual(suggestFund(mary, ctx), { fundId: 'f-gen', reason: 'guess' });
  assert.deepEqual(suggestFund(sam, ctx), { fundId: 'f-mis', reason: 'name' });
  assert.deepEqual(suggestFund(ann, ctx), { fundId: 'f-mis', reason: 'remembered' });
});

console.log(`\n${passed} unit tests passed`);
