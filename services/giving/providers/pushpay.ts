/**
 * Pushpay adapter: Transactions → Export → "to CSV (Legacy)".
 *
 * Pushpay doesn't publish a fixed column list, and labels differ between
 * accounts and export versions, so columns are recognised by name (aliases
 * below) and anything unrecognised can be mapped by hand on the import screen.
 */
import type {
  ColumnMapping, CsvTable, ElectronicMethod, FieldDef, FileProvider, GiftRecord, GiftStatus,
  ParseOptions, ParseResult, SkippedRow,
} from '../types';
import { detectDateOrder, hashString, normHeader, parseAmount, parseDate } from '../parse';

const FIELDS: FieldDef[] = [
  { key: 'date', label: 'Date', required: true,
    aliases: ['date', 'payment date', 'transaction date', 'date given', 'gift date', 'received on', 'payment received on',
      'processed date', 'processed on', 'created', 'created date', 'created on', 'date/time', 'date time', 'settled date'] },
  { key: 'amount', label: 'Amount (gross)', required: true,
    aliases: ['amount', 'gross amount', 'total amount', 'gift amount', 'payment amount', 'amount given', 'total', 'gross'] },
  { key: 'externalId', label: 'Payment / Transaction ID',
    aliases: ['payment id', 'transaction id', 'transaction number', 'payment number', 'payment reference', 'transaction reference',
      'reference number', 'reference', 'payment token', 'transaction token', 'id'],
    hint: 'Strongly recommended: lets re-imports skip gifts already brought in.' },
  { key: 'fee', label: 'Fee', aliases: ['fee', 'fees', 'processing fee', 'transaction fee', 'merchant fee', 'pushpay fee', 'fee amount', 'total fees'] },
  { key: 'net', label: 'Net amount', aliases: ['net', 'net amount', 'amount net', 'net total', 'settled amount', 'deposit amount'] },
  { key: 'currency', label: 'Currency', aliases: ['currency', 'currency code'] },
  { key: 'method', label: 'Payment method', aliases: ['payment type', 'payment method', 'method', 'card type', 'payment method type', 'tender', 'type'] },
  { key: 'status', label: 'Status', aliases: ['status', 'payment status', 'transaction status', 'state'] },
  { key: 'source', label: 'Payment source', aliases: ['payment source', 'transaction source', 'source', 'channel'] },
  { key: 'refund', label: 'Refund', aliases: ['refund', 'refunded', 'refund type', 'refund status'] },
  { key: 'payerId', label: 'Payer ID', aliases: ['payer id', 'person id', 'payer reference', 'member id', 'customer id', 'pushpay payer id',
      'payer key', 'giver id', 'donor id', 'individual id', 'pushpay id'] },
  { key: 'firstName', label: 'First name', aliases: ['first name', 'payer first name', "payer's first name", 'firstname', 'given name'] },
  { key: 'lastName', label: 'Last name', aliases: ['last name', 'payer last name', "payer's last name", 'lastname', 'surname', 'family name'] },
  { key: 'payerName', label: 'Payer name', aliases: ['payer name', 'name', 'full name', 'payer full name', 'payer', 'giver name', 'giver', 'donor name', 'donor'] },
  { key: 'email', label: 'Email', aliases: ['email', 'email address', 'payer email', "payer's email", 'e-mail', 'payer email address'] },
  { key: 'phone', label: 'Mobile number', aliases: ['mobile number', 'mobile phone', "payer's mobile phone number", 'payer mobile', 'phone', 'phone number', 'mobile'] },
  { key: 'address', label: 'Address', aliases: ['address', 'address 1', 'address line 1', 'address1', 'street', 'street address', "payer's address"] },
  { key: 'address2', label: 'Address line 2', aliases: ['address 2', 'address line 2', 'address2'] },
  { key: 'city', label: 'City', aliases: ['city', 'town', 'suburb'] },
  { key: 'region', label: 'State / Province', aliases: ['state', 'province', 'region', 'state/province'] },
  { key: 'postal', label: 'ZIP / Postal code', aliases: ['zip', 'zip code', 'postal code', 'postcode', 'zip/postal code'] },
  { key: 'country', label: 'Country', aliases: ['country'] },
  { key: 'fundCode', label: 'Fund code', aliases: ['fund code', 'fund id', 'fund number', 'designation code', 'fund reference'] },
  { key: 'fundName', label: 'Fund name', aliases: ['fund name', 'fund', 'designation', 'fund/designation', 'gift designation', 'fund description'] },
  { key: 'memo', label: 'Memo', aliases: ['memo', 'notes', 'note', 'comment', 'comments', 'payer comment', 'message'] },
  { key: 'depositRef', label: 'Batch / Deposit', aliases: ['batch', 'batch id', 'batch name', 'batch number', 'deposit', 'deposit id',
      'deposit number', 'settlement', 'settlement id', 'settlement batch', 'payout id', 'transfer id'] },
];

export function detectMapping(headers: string[]): ColumnMapping {
  const norm = headers.map(normHeader);
  const used = new Set<number>();
  const mapping: ColumnMapping = {};
  // Earlier aliases win; a column is only used once.
  for (const f of FIELDS) {
    for (const a of f.aliases) {
      const idx = norm.findIndex((h, i) => h === a && !used.has(i));
      if (idx !== -1) { mapping[f.key] = idx; used.add(idx); break; }
    }
  }
  return mapping;
}

function missingFields(mapping: ColumnMapping): FieldDef[] {
  const missing = FIELDS.filter(f => f.required && mapping[f.key] === undefined);
  const hasPayer = ['payerName', 'firstName', 'lastName', 'email', 'payerId'].some(k => mapping[k] !== undefined);
  if (!hasPayer) missing.push({ key: 'payerName', label: 'Payer name (or first/last name, email or payer ID)', aliases: [] });
  return missing;
}

const OFFLINE = /\b(cash|check|cheque|non-?cash|recorded|stock|in[- ]?kind|securities)\b/i;
const OFFLINE_SOURCE = /batch entry|gift entry|transaction import/i;
const CARD = /card|visa|master|amex|american express|discover|apple|google|credit|debit|interac online/i;
const BANK = /\bach\b|bank|\beft\b|\bpad\b|direct debit|e-?check/i;

export function classifyMethod(v: string): ElectronicMethod | 'offline' {
  if (OFFLINE.test(v)) return 'offline';
  if (CARD.test(v)) return 'card';
  if (BANK.test(v)) return 'bank_debit';
  return 'online';
}

export function classifyStatus(v: string): GiftStatus {
  const s = v.toLowerCase();
  if (!s.trim()) return 'succeeded';
  if (/refund|revers|return|chargeback|void/.test(s)) return 'refunded';
  if (/fail|declin|reject|error|cancel/.test(s)) return 'failed';
  if (/pend|processing|in progress|schedul|initiat|await/.test(s)) return 'pending';
  return 'succeeded';
}

const truthy = (v: string) => !!v.trim() && !/^(no|false|0|n|none|-)$/i.test(v.trim());

function parse(table: CsvTable, mapping: ColumnMapping, options: ParseOptions): ParseResult {
  const gifts: GiftRecord[] = [];
  const skipped: SkippedRow[] = [];
  const warnings: string[] = [];
  const at = (row: string[], key: string) => {
    const i = mapping[key];
    return i === undefined ? '' : (row[i] ?? '').trim();
  };

  const order = options.dateOrder === 'auto'
    ? detectDateOrder(table.rows.map(r => at(r, 'date')))
    : options.dateOrder;
  if (options.dateOrder === 'auto' && order === 'mdy') {
    // Warn only when nothing in the file proves month/day (e.g. 11/23/2026)
    const short = table.rows.map(r => at(r, 'date').match(/^(\d{1,2})[/.-](\d{1,2})[/.-]/)).filter(Boolean) as RegExpMatchArray[];
    if (short.length > 0 && !short.some(m => +m[2] > 12))
      warnings.push('Dates were read as month/day/year. Change "Date order" if that is wrong.');
  }
  if (mapping.externalId === undefined)
    warnings.push('No Payment ID column: gifts are identified by their contents. Re-importing the same file is still safe, but identical gifts on the same day from the same person can only be told apart by their order in the file.');

  const occurrences = new Map<string, number>();

  table.rows.forEach((row, i) => {
    const line = table.firstDataLine + i;
    const first = at(row, 'firstName'), last = at(row, 'lastName');
    const payerName = at(row, 'payerName') || [first, last].filter(Boolean).join(' ');
    const summary = [at(row, 'date'), payerName || at(row, 'email'), at(row, 'amount')].filter(Boolean).join(' · ');
    const skip = (reason: string) => skipped.push({ line, reason, summary });

    const amount = parseAmount(at(row, 'amount'));
    if (Number.isNaN(amount)) return skip(`Amount "${at(row, 'amount')}" is not a number`);
    if (amount < 0) return skip('Refund or reversal (negative amount)');
    if (amount === 0) return skip('Zero amount');

    const giftDate = parseDate(at(row, 'date'), order);
    if (!giftDate) return skip(`Date "${at(row, 'date')}" not recognised`);

    const methodText = at(row, 'method');
    const method = classifyMethod(methodText);
    if (method === 'offline')
      return skip(`Recorded in Pushpay as "${methodText}" — count it in an in-person batch instead`);
    const sourceText = at(row, 'source');
    if (OFFLINE_SOURCE.test(sourceText))
      return skip(`Entered in Pushpay by staff ("${sourceText}") — not an online gift`);

    let status = classifyStatus(at(row, 'status'));
    if (truthy(at(row, 'refund'))) status = 'refunded';
    if (status === 'failed') return skip('Failed payment');

    let fee = Math.abs(parseAmount(at(row, 'fee')));
    if (Number.isNaN(fee)) {
      const net = parseAmount(at(row, 'net'));
      fee = !Number.isNaN(net) && net <= amount ? Math.round((amount - net) * 100) / 100 : 0;
    }

    const email = at(row, 'email').toLowerCase();
    if (!payerName && !email && !at(row, 'payerId')) return skip('No payer name, email or ID');

    const fundCode = at(row, 'fundCode');
    const fundName = at(row, 'fundName');

    let externalId = at(row, 'externalId');
    if (!externalId) {
      const key = [giftDate, amount.toFixed(2), payerName.toLowerCase(), email, fundCode || fundName, methodText, at(row, 'memo')].join('|');
      const n = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, n);
      externalId = `H${hashString(key)}-${n}`;
    }

    const raw: Record<string, string> = {};
    table.headers.forEach((h, j) => { if (h && (row[j] ?? '').trim()) raw[h] = row[j].trim(); });

    const address = [at(row, 'address'), at(row, 'address2'), at(row, 'city'), at(row, 'region'), at(row, 'postal'), at(row, 'country')]
      .filter(Boolean).join(', ');

    gifts.push({
      externalId, giftDate, amount, fee, currency: at(row, 'currency') || undefined, method, status,
      payerExternalId: at(row, 'payerId') || undefined,
      payerFirstName: first || undefined, payerLastName: last || undefined, payerName: payerName || undefined,
      payerEmail: email || undefined, payerPhone: at(row, 'phone') || undefined, payerAddress: address || undefined,
      fundKey: fundCode || fundName || undefined, fundName: fundName || fundCode || undefined,
      memo: at(row, 'memo') || undefined, depositRef: at(row, 'depositRef') || undefined, raw,
    });
  });

  return { gifts, skipped, warnings };
}

export const pushpayProvider: FileProvider = {
  kind: 'file',
  id: 'pushpay',
  label: 'Pushpay',
  description: 'Online gifts made through Pushpay (app, web and text giving).',
  accept: '.csv,text/csv',
  exportSteps: [
    'Sign in to Pushpay and open Transactions.',
    'Set the Transaction period and choose Apply Filter.',
    'Choose Export → "to CSV (Legacy)" and upload the file here.',
  ],
  fields: FIELDS,
  detectMapping,
  missingFields,
  parse,
};
