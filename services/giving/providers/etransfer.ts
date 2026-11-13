/**
 * Interac e-Transfer adapter: reads the deposit notification emails the
 * church receives ("JOHN SMITH sent you $50.00", Autodeposit notices), one
 * gift per email.
 *
 * Input: .eml files (saved from Gmail / Outlook), an .mbox export, or email
 * text pasted in. The reader itself (parseInteracEmail) lives in
 * supabase/functions/_shared/interac.ts and is the same code the
 * mailbox-poll Edge Function runs for automatic intake.
 */
import PostalMime from 'postal-mime';
import type { DocumentProvider, GiftRecord, ParseResult, SkippedRow, SourceDoc } from '../types';
import {
  FLAG_TEXT, emailPartsFromMime, fromForwardedHeaders, htmlToText, parseInteracEmail, type EmailParts,
} from '../../../supabase/functions/_shared/interac';

export { envelopeFromMemo, parseInteracEmail } from '../../../supabase/functions/_shared/interac';
export type { EmailParts } from '../../../supabase/functions/_shared/interac';

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
      out.push({ label, email: emailPartsFromMime(await PostalMime.parse(chunk), fileDate) });
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
      gifts.push(r.gift as GiftRecord);
      for (const f of r.gift.flags) notes.set(f, [...(notes.get(f) ?? []), r.gift.payerName ?? label]);
    }
  }
  const warnings = [...notes.entries()].map(([f, who]) =>
    `${who.length} flagged for review — ${FLAG_TEXT[f] ?? f} (${who.slice(0, 5).join(', ')}${who.length > 5 ? '…' : ''})`);
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
