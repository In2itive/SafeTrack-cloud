/** Generic file helpers shared by file-based giving providers. */
import type { CsvTable, DateOrder } from './types';

/** RFC 4180 CSV: quoted fields, doubled quotes, commas/newlines inside quotes, BOM. */
export function parseCsv(text: string): CsvTable {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records: string[][] = [];
  const lineOf: number[] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let line = 1;
  let rowStart = 1;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      records.push(row); lineOf.push(rowStart);
      row = []; line++; rowStart = line;
      continue;
    }
    field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); records.push(row); lineOf.push(rowStart); }

  // Skip blank lines and any preamble before the header (some exports start with a title row)
  const nonBlank = records.map((r, i) => ({ r, line: lineOf[i] })).filter(x => x.r.some(v => v.trim() !== ''));
  if (nonBlank.length === 0) throw new Error('The file is empty');
  const widest = Math.max(...nonBlank.slice(0, 20).map(x => x.r.length));
  const headerIdx = nonBlank.findIndex(x => x.r.length === widest);
  const headers = nonBlank[headerIdx].r.map(h => h.trim());
  const body = nonBlank.slice(headerIdx + 1);
  return {
    headers,
    rows: body.map(x => x.r),
    firstDataLine: body[0]?.line ?? nonBlank[headerIdx].line + 1,
  };
}

export const normHeader = (h: string) => h.toLowerCase().replace(/[’']/g, "'").replace(/[_\s]+/g, ' ').trim();

export { parseAmount, hashString } from '../../supabase/functions/_shared/interac';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const iso = (y: number, m: number, d: number): string | null => {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** Decide day/month order from the values in a column (for 'auto'). */
export function detectDateOrder(values: string[]): Exclude<DateOrder, 'auto'> {
  let dmy = false, mdy = false;
  for (const v of values) {
    const m = v.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
    if (!m) continue;
    if (+m[1] > 12) dmy = true;
    if (+m[2] > 12) mdy = true;
  }
  if (dmy && !mdy) return 'dmy';
  return 'mdy'; // Pushpay and most North American exports
}

/** Many date styles -> YYYY-MM-DD, or null. Time portions are ignored. */
export function parseDate(v: string | undefined, order: Exclude<DateOrder, 'auto'>): string | null {
  if (!v) return null;
  const s = v.trim();
  let m = s.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) return order === 'dmy' ? iso(+m[3], +m[2], +m[1]) : iso(+m[3], +m[1], +m[2]);
  m = s.match(/^(?:[A-Za-z]+,?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);       // Nov 8, 2026 / Sunday, November 8, 2026
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon) return iso(+m[3], mon, +m[2]);
  }
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?[\s-](\d{2,4})/);                      // 8 Nov 2026 / 08-Nov-26
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return iso(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  return null;
}
