/**
 * Interac e-Transfer notification reader — shared by the browser (manual
 * upload) and the mailbox-poll Edge Function (automatic intake).
 *
 * Pure TypeScript with NO imports, so it runs unchanged in Vite and Deno.
 * MIME decoding (postal-mime) happens in each caller; this module takes the
 * decoded subject/headers/text.
 *
 * Banks and Interac change the wording, and notices come in English or
 * French, so fields are found by label and phrase, never by position.
 */

export interface EmailParts {
  subject?: string;
  from?: string;            // address
  replyTo?: string;         // address
  to?: string[];
  date?: string;            // ISO
  messageId?: string;
  /** Authentication-Results header(s) added by the receiving mail server, if any. */
  authResults?: string;
  text: string;
}

/** Review flags a gift can carry. Flagged gifts are never posted automatically. */
export const FLAG_TEXT: Record<string, string> = {
  not_from_interac: "Sender isn't Interac (notify@payments.interac.ca). Could be forwarded or fake: check the bank statement.",
  auth_failed: 'The mail server could not verify this email came from Interac (DKIM/DMARC failed). Possible fake.',
  no_reference: 'No Interac reference number. Identified by date, amount and sender instead.',
  no_sender_email: "No sender email found, so the giver can't be matched by e-Transfer ID.",
  envelope_not_found: 'The memo gives an envelope number that is not in the Giver Registry.',
  envelope_email_mismatch: "The memo's envelope belongs to a giver whose recorded e-Transfer emails don't include this sender.",
  needs_giver: 'No confident giver match.',
  fund_unclear: "The memo doesn't clearly name one fund.",
  status_not_succeeded: 'The transfer is not marked as deposited.',
};

export interface InteracGift {
  externalId: string;
  giftDate: string;
  amount: number;
  fee: number;
  currency: string;
  method: 'e_transfer';
  status: 'succeeded';
  payerExternalId?: string;
  payerEnvelope?: number;
  payerName?: string;
  payerFirstName?: string;
  payerLastName?: string;
  payerEmail?: string;
  memo?: string;
  /** The message exactly as it appears in the email (before any tidying). */
  memoRaw?: string;
  flags: string[];
  raw: Record<string, string>;
}

export type InteracResult = { gift: InteracGift } | { skip: string };

// ---------------------------------------------------------------------------
// Small helpers (also re-exported for the browser's file parsers)
// ---------------------------------------------------------------------------

/** "$1,234.56", "1234.56 CAD", "(25.00)", "1 250,50 $" -> number; NaN when not a number. */
export function parseAmount(v: string | undefined): number {
  if (v === undefined) return NaN;
  let s = v.trim();
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[A-Za-z$€£\s  ]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');                 // 1.234,56
  else if (/^\d{1,3}([   ]\d{3})*,\d{2}$/.test(v.trim().replace(/[^\d   ,]/g, '').trim()))
    s = s.replace(',', '.');                                                                              // 50,00 / 1 234,56 (fr-CA)
  else s = s.replace(/,/g, '');
  if (!/^\d*\.?\d+$/.test(s)) return NaN;
  const n = Math.round(parseFloat(s) * 100) / 100;
  return neg ? -n : n;
}

/** Stable short hash (FNV-1a, hex) for synthesising ids when there are none. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const htmlToText = (html: string) => html
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#36;|&dollar;/g, '$')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');

const INTERAC_DOMAIN = /payments\.interac\.ca|interac\.ca/i;
const NOT_A_DEPOSIT = /request(?:ed)? money|money request|demande de fonds|cancel+ed|annul|declin|refus|expire|reminder|rappel|has not been deposited|n'a pas été déposé|stopped|returned to you/i;

const titleCase = (s: string) =>
  s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s\-'’.])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : s;

const clean = (s?: string) => s?.replace(/\s+/g, ' ').replace(/^["'“”\s]+|["'“”\s.]+$/g, '').trim() || undefined;

/** Calendar date of an instant in the church's time zone (YYYY-MM-DD). */
export function dateInZone(d: Date, timeZone?: string): string {
  if (!timeZone) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Envelope number written in a memo: "env 123", "Envelope #123", "enveloppe no 45", or just "123". */
export function envelopeFromMemo(memo?: string): number | undefined {
  if (!memo) return undefined;
  const m = memo.match(/\benv(?:e?lope?|eloppe)?\.?\s*(?:#|no\.?|num(?:ber|éro)?\.?|n°)?\s*:?\s*#?\s*(\d{1,5})\b/i)
         ?? memo.match(/^\s*#?\s*(\d{1,5})\s*$/);
  return m ? parseInt(m[1], 10) : undefined;
}

/** Subject/from/date that a forwarded email repeats in its body. */
export function fromForwardedHeaders(text: string): Partial<EmailParts> {
  const h = (k: string) => text.match(new RegExp(`^\\s*(?:${k})\\s*:\\s*(.+)$`, 'im'))?.[1]?.trim();
  const date = h('date|sent|envoyé');
  const parsed = date ? Date.parse(date.replace(/ at /, ' ')) : NaN;
  return {
    subject: h('subject|objet'),
    from: h('from|de')?.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0],
    date: Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString(),
  };
}

/** The shape postal-mime returns (only what we use). */
export interface MimeLike {
  subject?: string;
  from?: { address?: string };
  replyTo?: { address?: string }[];
  to?: { address?: string }[];
  date?: string;
  messageId?: string;
  headers?: { key: string; value: string }[];
  text?: string;
  html?: string;
}

/** Decoded MIME message -> EmailParts, unwrapping a forwarded notification. */
export function emailPartsFromMime(m: MimeLike, fallbackDate?: string): EmailParts {
  const bodyText = m.text?.trim() ? m.text : htmlToText(m.html ?? '');
  const fwd = fromForwardedHeaders(bodyText);
  const forwarded = /^(fw|fwd|tr)\s*:/i.test(m.subject ?? '');
  return {
    subject: forwarded && fwd.subject ? fwd.subject : (m.subject ?? fwd.subject),
    from: forwarded && fwd.from ? fwd.from : m.from?.address,
    replyTo: forwarded ? undefined : m.replyTo?.[0]?.address,
    to: (m.to ?? []).map(x => x.address).filter((x): x is string => !!x),
    date: forwarded && fwd.date ? fwd.date : (m.date ?? fwd.date ?? fallbackDate),
    messageId: m.messageId,
    authResults: forwarded ? undefined
      : (m.headers ?? []).filter(h => h.key.toLowerCase() === 'authentication-results').map(h => h.value).join('\n') || undefined,
    text: bodyText,
  };
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/** One notification email -> one gift (or a reason to skip it). */
export function parseInteracEmail(e: EmailParts, opts: { timeZone?: string } = {}): InteracResult {
  const subject = e.subject ?? '';
  const body = e.text.replace(/\r/g, '');
  const all = `${subject}\n${body}`;
  const flat = all.replace(/\s+/g, ' ');
  const flags: string[] = [];

  if (!/e-?transfer|virement/i.test(all)) return { skip: 'Not an Interac e-Transfer notification' };
  if (NOT_A_DEPOSIT.test(subject) || (!/sent you|deposited|d\S{1,2}pos\S{1,2}|vous a envoy|received|re\S{1,2}u\b/i.test(flat) && NOT_A_DEPOSIT.test(flat)))
    return { skip: 'Not a deposit (request, reminder, cancellation or expiry notice)' };

  // ---- amount ----
  const amtNear = flat.match(/(?:sent you|vous a envoy\S{0,2}|deposited|d\S{1,2}pos\S{1,2}|amount|montant)[^$\d]{0,60}?(\$\s?[\d,]+(?:\.\d{2})?|[\d\s  ]+,\d{2}\s?\$)/i)
               ?? flat.match(/(\$\s?[\d,]+\.\d{2}|[\d\s  ]+,\d{2}\s?\$)/);
  const amount = amtNear ? parseAmount(amtNear[1]) : NaN;
  if (!(amount > 0)) return { skip: 'No amount found' };

  // ---- reference number ----
  const ref = flat.match(/(?:reference\s*(?:number|no\.?|#)?|num\S{1,3}ro de r\S{1,3}f\S{1,3}rence|r\S{1,3}f\S{1,3}rence)\s*[:#]?\s*([A-Za-z0-9]{8,24})\b/i)?.[1];

  // ---- sender name + email ----
  let name: string | undefined;
  let email: string | undefined;
  const nameEmail = (re: RegExp) => { const m = flat.match(re); if (m) { name ??= clean(m[1]); email ??= m[2]?.toLowerCase(); } };
  nameEmail(/(?:INTERAC e-Transfer|Virement INTERAC)\s*:\s*(.+?)\s+(?:\(([^()\s]+@[^()\s]+)\)\s+)?(?:has\s+)?(?:sent you|vous a envoy)/i);
  nameEmail(/(?:money transfer|transfer|virement)\s+(?:from|de)\s+(.+?)\s+(?:\(([^()\s]+@[^()\s]+)\)\s+)?(?:has been|a été)/i);
  nameEmail(/(?:^|[,.:!]\s+|\n)([\p{L}][\p{L}'’.\- &]{1,80}?)\s+(?:\(([^()\s]+@[^()\s]+)\)\s+)?(?:has\s+)?(?:sent you|vous a envoy\S{0,2})(?=\s|$)/iu);
  const label = (re: RegExp) => clean(body.match(re)?.[1]);
  name ??= label(/^\s*(?:sender(?:'s)?(?: name)?|sent by|from|expéditeur|de la part de)\s*:\s*(.+)$/im);
  email ??= label(/(?:sender(?:'s)?\s*e-?mail(?: address)?|e-?mail(?: address)?|courriel(?: de l'expéditeur)?)\s*:\s*([^\s<>()]+@[^\s<>()]+)/i)?.toLowerCase();
  if (!email && e.replyTo && !INTERAC_DOMAIN.test(e.replyTo)) email = e.replyTo.toLowerCase();
  if (!email) {
    const exclude = new Set((e.to ?? []).map(x => x.toLowerCase()));
    const found = [...new Set((body.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).map(x => x.toLowerCase()))]
      .filter(x => !INTERAC_DOMAIN.test(x) && !exclude.has(x) && !/no-?reply|notify|catch|support|help|bank|caisse/i.test(x));
    if (found.length === 1) email = found[0];
  }
  if (name && /^(hi|hello|bonjour|dear)\b/i.test(name)) name = undefined;
  if (!name && !email) return { skip: 'No sender name or email found' };
  if (!email) flags.push('no_sender_email');

  // ---- message / memo (kept exactly as written, and tidied) ----
  const memoMatch = body.match(/^[ \t]*(?:message(?: from sender)?|memo|note|message de l'expéditeur)[ \t]*:[ \t]*(.*)$/im);
  let memoRaw = memoMatch?.[1];
  if (memoMatch && !memoRaw?.trim()) {
    // label on its own line: the message is on the next non-empty line
    memoRaw = body.slice((memoMatch.index ?? 0) + memoMatch[0].length).split('\n').find(l => l.trim());
  }
  memoRaw = memoRaw?.trim() || undefined;   // the words exactly as written; only surrounding blank space dropped
  let memoText = clean(memoRaw);
  if (memoText && /^(none|aucun|n\/a|-)$/i.test(memoText)) memoText = undefined;

  // ---- date ----
  let giftDate: string | undefined;
  if (e.date && !Number.isNaN(Date.parse(e.date))) giftDate = dateInZone(new Date(e.date), opts.timeZone);
  if (!giftDate) {
    const d = body.match(/^\s*(?:date|sent on|deposited on|date d'envoi|envoyé le)\s*:\s*(.+)$/im)?.[1];
    if (d && !Number.isNaN(Date.parse(d))) giftDate = dateInZone(new Date(d), opts.timeZone);
  }
  if (!giftDate) return { skip: 'No date found (upload the email file rather than pasting, so its date comes along)' };

  // ---- authenticity ----
  if (!INTERAC_DOMAIN.test(`${e.from ?? ''} ${all}`)) flags.push('not_from_interac');
  if (e.authResults && /\b(dkim|dmarc)=(fail|permerror)\b/i.test(e.authResults)) flags.push('auth_failed');

  const displayName = name ? titleCase(name) : undefined;
  const parts = displayName?.split(/\s+/) ?? [];
  const externalId = ref ?? `H${hashString([giftDate, amount.toFixed(2), (name ?? '').toLowerCase(), email ?? '', memoText ?? ''].join('|'))}`;
  if (!ref) flags.push('no_reference');

  return {
    gift: {
      externalId, giftDate, amount, fee: 0, currency: 'CAD', method: 'e_transfer', status: 'succeeded',
      payerExternalId: email,                // e-Transfers are tied to the sender's email
      payerEnvelope: envelopeFromMemo(memoText),
      payerName: displayName,
      payerFirstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : undefined,
      payerLastName: parts.length > 1 ? parts[parts.length - 1] : undefined,
      payerEmail: email,
      memo: memoText,
      memoRaw,
      flags,
      raw: {
        subject, from: e.from ?? '', date: e.date ?? '', reference: ref ?? '', message_raw: memoRaw ?? '',
        ...(e.messageId ? { message_id: e.messageId } : {}),
      },
    },
  };
}
