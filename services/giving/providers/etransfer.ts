/**
 * Interac e-Transfer adapter: reads the deposit notification emails the
 * church receives ("JOHN SMITH sent you $50.00", Autodeposit notices), one
 * gift per email.
 *
 * Input: .eml files (saved from Gmail / Outlook), an .mbox export, or email
 * text pasted in. The same parseInteracEmail() is meant to run server-side
 * later, when notifications are forwarded to an inbound address
 * (docs/GIVING_PROVIDERS.md).
 *
 * Banks and Interac change the wording, and notices come in English or
 * French, so fields are found by label and phrase, never by position.
 */
import PostalMime from 'postal-mime';
import type { DocumentProvider, GiftRecord, ParseResult, SkippedRow, SourceDoc } from '../types';
import { hashString, parseAmount } from '../parse';

export interface EmailParts {
  subject?: string;
  from?: string;          // address
  replyTo?: string;       // address
  to?: string[];
  date?: string;          // ISO
  text: string;
}

const INTERAC_DOMAIN = /payments\.interac\.ca|interac\.ca/i;
const NOT_A_DEPOSIT = /request(?:ed)? money|money request|demande de fonds|cancel+ed|annul|declin|refus|expire|reminder|rappel|has not been deposited|n'a pas été déposé|stopped|returned to you/i;

const htmlToText = (html: string) => html
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#36;|&dollar;/g, '$')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');

const titleCase = (s: string) =>
  s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s\-'’.])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : s;

const clean = (s?: string) => s?.replace(/\s+/g, ' ').replace(/^["'“”\s]+|["'“”\s.]+$/g, '').trim() || undefined;

const localIsoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Envelope number written in a memo: "env 123", "Envelope #123", "enveloppe no 45", or just "123". */
export function envelopeFromMemo(memo?: string): number | undefined {
  if (!memo) return undefined;
  const m = memo.match(/\benv(?:e?lope?|eloppe)?\.?\s*(?:#|no\.?|num(?:ber|éro)?\.?|n°)?\s*:?\s*#?\s*(\d{1,5})\b/i)
         ?? memo.match(/^\s*#?\s*(\d{1,5})\s*$/);
  return m ? parseInt(m[1], 10) : undefined;
}

export type InteracResult = { gift: GiftRecord; warnings: string[] } | { skip: string };

/** One notification email -> one gift (or a reason to skip it). */
export function parseInteracEmail(e: EmailParts): InteracResult {
  const subject = e.subject ?? '';
  const body = e.text.replace(/\r/g, '');
  const all = `${subject}\n${body}`;
  const flat = all.replace(/\s+/g, ' ');
  const warnings: string[] = [];

  if (!/e-?transfer|virement/i.test(all)) return { skip: 'Not an Interac e-Transfer notification' };
  if (NOT_A_DEPOSIT.test(subject) || (!/sent you|deposited|déposé|vous a envoyé|received|reçu/i.test(flat) && NOT_A_DEPOSIT.test(flat)))
    return { skip: 'Not a deposit (request, reminder, cancellation or expiry notice)' };

  // ---- amount ----
  const amtNear = flat.match(/(?:sent you|vous a envoyé|deposited|déposé|amount|montant)[^$\d]{0,60}?(\$\s?[\d,]+(?:\.\d{2})?|[\d\s ]+,\d{2}\s?\$)/i)
               ?? flat.match(/(\$\s?[\d,]+\.\d{2}|[\d\s ]+,\d{2}\s?\$)/);
  const amount = amtNear ? parseAmount(amtNear[1].replace(/ /g, ' ')) : NaN;
  if (!(amount > 0)) return { skip: 'No amount found' };

  // ---- reference number ----
  const ref = flat.match(/(?:reference\s*(?:number|no\.?|#)?|num[ée]ro de r[ée]f[ée]rence|r[ée]f[ée]rence)\s*[:#]?\s*([A-Za-z0-9]{8,24})\b/i)?.[1];

  // ---- sender name + email ----
  let name: string | undefined;
  let email: string | undefined;
  const nameEmail = (re: RegExp) => { const m = flat.match(re); if (m) { name ??= clean(m[1]); email ??= m[2]?.toLowerCase(); } };
  nameEmail(/(?:INTERAC e-Transfer|Virement INTERAC)\s*:\s*(.+?)\s+(?:\(([^()\s]+@[^()\s]+)\)\s+)?(?:has\s+)?(?:sent you|vous a envoy)/i);
  nameEmail(/(?:money transfer|transfer|virement)\s+(?:from|de)\s+(.+?)\s+(?:\(([^()\s]+@[^()\s]+)\)\s+)?(?:has been|a été)/i);
  nameEmail(/(?:^|[,.:!]\s+|\n)([\p{L}][\p{L}'’.\- &]{1,80}?)\s+(?:\(([^()\s]+@[^()\s]+)\)\s+)?(?:has\s+)?(?:sent you|vous a envoyé)\b/iu);
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

  // ---- message / memo ----
  let memo = body.match(/^\s*(?:message(?: from sender)?|memo|note|message de l'expéditeur)\s*:[ \t]*(.*)$/im);
  let memoText = memo?.[1]?.trim();
  if (memo && !memoText) {
    // label on its own line: the message is on the next non-empty line
    const after = body.slice((memo.index ?? 0) + memo[0].length).split('\n').map(l => l.trim()).find(Boolean);
    memoText = after;
  }
  memoText = clean(memoText);
  if (memoText && /^(none|aucun|n\/a|-)$/i.test(memoText)) memoText = undefined;

  // ---- date ----
  let giftDate: string | undefined;
  if (e.date && !Number.isNaN(Date.parse(e.date))) giftDate = localIsoDate(new Date(e.date));
  if (!giftDate) {
    const d = body.match(/^\s*(?:date|sent on|deposited on|date d'envoi|envoyé le)\s*:\s*(.+)$/im)?.[1];
    if (d && !Number.isNaN(Date.parse(d))) giftDate = localIsoDate(new Date(d));
  }
  if (!giftDate) return { skip: 'No date found (upload the email file rather than pasting, so its date comes along)' };

  if (!INTERAC_DOMAIN.test(`${e.from ?? ''} ${all}`))
    warnings.push('does not show Interac (notify@payments.interac.ca) as the sender');

  const displayName = name ? titleCase(name) : undefined;
  const parts = displayName?.split(/\s+/) ?? [];
  const externalId = ref ?? `H${hashString([giftDate, amount.toFixed(2), (name ?? '').toLowerCase(), email ?? '', memoText ?? ''].join('|'))}`;
  if (!ref) warnings.push('has no reference number; it is identified by date, amount and sender');

  return {
    warnings,
    gift: {
      externalId, giftDate, amount, fee: 0, currency: 'CAD', method: 'e_transfer', status: 'succeeded',
      payerExternalId: email,                // e-Transfers are tied to the sender's email
      payerEnvelope: envelopeFromMemo(memoText),
      payerName: displayName,
      payerFirstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : undefined,
      payerLastName: parts.length > 1 ? parts[parts.length - 1] : undefined,
      payerEmail: email,
      memo: memoText,
      raw: { subject, from: e.from ?? '', date: e.date ?? '', reference: ref ?? '', message: memoText ?? '' },
    },
  };
}

// ---------------------------------------------------------------------------
// Splitting uploads into individual emails
// ---------------------------------------------------------------------------
/** A raw email: the block before the first blank line is all "Header: value" lines, including some standard ones. */
function looksLikeMime(t: string): boolean {
  const head = t.replace(/^\s+/, '').split(/\r?\n\r?\n/)[0].split(/\r?\n/);
  if (head.length < 2 || !/^[\w-]+:/.test(head[0])) return false;
  if (!head.every(l => /^[\w-]+:/.test(l) || /^[ \t]/.test(l))) return false;
  return head.filter(l => /^(from|to|subject|date|received|return-path|mime-version|message-id|content-type):/i.test(l)).length >= 2;
}

/** .mbox: messages start with a "From " line. */
const splitMbox = (t: string) => t.split(/\r?\n(?=From \S+.*\d{4}\r?\n)/).map(s => s.replace(/^From \S+.*\r?\n/, ''));

/** Pasted text: split at forwarded-message markers or at a new "INTERAC e-Transfer:" heading. */
export function splitPasted(t: string): string[] {
  const parts = t.split(/\n(?=\s*(?:-{3,}\s*(?:forwarded message|original message|message transféré)|begin forwarded message:|subject:\s*(?:fw:|fwd:|tr:)?\s*interac e-transfer|interac e-transfer\s*:))/i)
    .map(s => s.trim()).filter(Boolean);
  // re-attach fragments that have no amount to the previous part
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && !/\$\s?[\d,]+\.\d{2}|[\d\s]+,\d{2}\s?\$/.test(p)) out[out.length - 1] += '\n' + p;
    else out.push(p);
  }
  return out;
}

/** Pull the subject/from/date that a forwarded email repeats in its body. */
function fromForwardedHeaders(text: string): Partial<EmailParts> {
  const h = (k: string) => text.match(new RegExp(`^\\s*(?:${k})\\s*:\\s*(.+)$`, 'im'))?.[1]?.trim();
  const date = h('date|sent|envoyé');
  return {
    subject: h('subject|objet'),
    from: h('from|de')?.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0],
    date: date && !Number.isNaN(Date.parse(date.replace(/ at /, ' '))) ? new Date(date.replace(/ at /, ' ')).toISOString() : undefined,
  };
}

async function toEmails(doc: SourceDoc): Promise<{ label: string; email: EmailParts }[]> {
  const text = typeof doc.content === 'string' ? doc.content : new TextDecoder().decode(doc.content);
  const fileDate = doc.lastModified ? new Date(doc.lastModified).toISOString() : undefined;
  const chunks = /\.mbox$/i.test(doc.name) || /^From \S+.*\d{4}\r?\n/.test(text) ? splitMbox(text)
              : looksLikeMime(text) ? [text]
              : splitPasted(text);
  const out: { label: string; email: EmailParts }[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const label = chunks.length > 1 ? `${doc.name} #${i + 1}` : doc.name;
    if (looksLikeMime(chunk)) {
      const m = await PostalMime.parse(chunk);
      const bodyText = m.text?.trim() ? m.text : htmlToText(m.html ?? '');
      const fwd = fromForwardedHeaders(bodyText);
      const forwarded = /^(fw|fwd|tr)\s*:/i.test(m.subject ?? '');
      out.push({ label, email: {
        subject: forwarded && fwd.subject ? fwd.subject : (m.subject ?? fwd.subject),
        from: forwarded && fwd.from ? fwd.from : m.from?.address,
        replyTo: forwarded ? undefined : m.replyTo?.[0]?.address,
        to: (m.to ?? []).map(x => x.address).filter((x): x is string => !!x),
        date: forwarded && fwd.date ? fwd.date : (m.date ?? fwd.date ?? fileDate),
        text: bodyText,
      } });
    } else {
      const plain = /<\/?(html|body|div|table|p)\b/i.test(chunk) ? htmlToText(chunk) : chunk;
      const fwd = fromForwardedHeaders(plain);
      out.push({ label, email: { ...fwd, text: plain, date: fwd.date } });
    }
  }
  return out;
}

async function parseDocuments(docs: SourceDoc[]): Promise<ParseResult> {
  const gifts: GiftRecord[] = [];
  const skipped: SkippedRow[] = [];
  const notes = new Map<string, string[]>();
  const seen = new Set<string>();
  let line = 0;
  for (const doc of docs) {
    let emails: { label: string; email: EmailParts }[];
    try { emails = await toEmails(doc); }
    catch (e) { skipped.push({ line: ++line, reason: `Could not read: ${(e as Error).message}`, summary: doc.name }); continue; }
    for (const { label, email } of emails) {
      line++;
      const r = parseInteracEmail(email);
      if ('skip' in r) { skipped.push({ line, reason: r.skip, summary: `${label}${email.subject ? ` · ${email.subject}` : ''}` }); continue; }
      if (seen.has(r.gift.externalId)) { skipped.push({ line, reason: 'Same e-Transfer appears twice in this upload', summary: label }); continue; }
      seen.add(r.gift.externalId);
      gifts.push(r.gift);
      for (const w of r.warnings) notes.set(w, [...(notes.get(w) ?? []), r.gift.payerName ?? label]);
    }
  }
  const warnings = [...notes.entries()].map(([w, who]) =>
    `${who.length} email${who.length === 1 ? '' : 's'} ${w}: ${who.slice(0, 5).join(', ')}${who.length > 5 ? '…' : ''}. Check against the bank statement.`);
  return { gifts, skipped, warnings };
}

export const etransferProvider: DocumentProvider = {
  kind: 'documents',
  id: 'e_transfer',
  label: 'e-Transfer',
  description: 'Interac e-Transfers deposited straight to the church account.',
  accept: '.eml,.mbox,.txt,message/rfc822,text/plain',
  pasteHint: 'Or paste one or more e-Transfer notification emails here…',
  exportSteps: [
    'Gmail: open each notification, ⋮ → Download message (.eml). Outlook: drag the emails to a folder, or File → Save As.',
    'Upload them all at once, or paste the email text below.',
    'Re-uploading an email is safe: each e-Transfer reference number is only brought in once.',
  ],
  defaultGrouping: 'week',
  reconcileAgainst: 'the e-Transfer deposits on the bank statement',
  parseDocuments,
};
