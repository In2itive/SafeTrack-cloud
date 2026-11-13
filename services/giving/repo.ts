/** Data access for online giving. Provider-agnostic. */
import { supabase } from '../supabase';
import { invokeFunction, notifyChange, requireChurchId } from '../repo';
import type { ExternalTransactionRow, InboundMessageRow } from '../database.types';
import type {
  GiftRecord, InboxMessage, MailboxSettingsView, PostResult, ProviderId, StagedGift, StageResult,
} from './types';

function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

const toRow = (g: GiftRecord) => ({
  external_id: g.externalId, gift_date: g.giftDate, amount: g.amount.toFixed(2), fee: g.fee.toFixed(2),
  currency: g.currency ?? null, payment_method: g.method, status: g.status,
  payer_external_id: g.payerExternalId ?? null, payer_envelope: g.payerEnvelope ?? null,
  payer_first_name: g.payerFirstName ?? null,
  payer_last_name: g.payerLastName ?? null, payer_name: g.payerName ?? null, payer_email: g.payerEmail ?? null,
  payer_phone: g.payerPhone ?? null, payer_address: g.payerAddress ?? null, fund_key: g.fundKey ?? null,
  fund_name: g.fundName ?? null, memo: g.memo ?? null, deposit_ref: g.depositRef ?? null, raw: g.raw,
  memo_raw: g.memoRaw ?? null, review_flags: g.flags ?? [],
});

const fromRow = (r: ExternalTransactionRow): StagedGift => ({
  id: r.id, externalId: r.external_id, giftDate: r.gift_date, amount: Number(r.amount), fee: Number(r.fee),
  currency: r.currency ?? undefined, method: r.payment_method as StagedGift['method'], status: r.status,
  payerExternalId: r.payer_external_id ?? undefined, payerEnvelope: r.payer_envelope ?? undefined,
  payerFirstName: r.payer_first_name ?? undefined,
  payerLastName: r.payer_last_name ?? undefined, payerName: r.payer_name ?? undefined,
  payerEmail: r.payer_email ?? undefined, payerPhone: r.payer_phone ?? undefined,
  payerAddress: r.payer_address ?? undefined, fundKey: r.fund_key ?? undefined, fundName: r.fund_name ?? undefined,
  memo: r.memo ?? undefined, depositRef: r.deposit_ref ?? undefined, raw: (r.raw ?? {}) as Record<string, string>,
  giverId: r.giver_id ?? undefined, fundId: r.fund_id ?? undefined, ignored: r.ignored,
  donationId: r.donation_id ?? undefined, stagedAt: r.staged_at,
  memoRaw: r.memo_raw ?? undefined, reviewFlags: r.review_flags ?? [], matchFlags: r.match_flags ?? [],
  inboundMessageId: r.inbound_message_id ?? undefined,
});

/** Add gifts to the review queue. Safe to repeat: gifts are keyed on provider + external id. */
export async function stageGifts(provider: ProviderId, gifts: GiftRecord[]): Promise<StageResult> {
  const totals: StageResult = { inserted: 0, updated: 0, already_posted: 0, refunded_after_post: 0 };
  try {
    for (let i = 0; i < gifts.length; i += 500) {
      const res = must(await supabase.rpc('stage_external_transactions', {
        p_church_id: requireChurchId(), p_provider: provider, p_rows: gifts.slice(i, i + 500).map(toRow),
      })) as unknown as StageResult;
      (Object.keys(totals) as (keyof StageResult)[]).forEach(k => { totals[k] += Number(res[k] ?? 0); });
    }
    return totals;
  } finally { notifyChange(); }
}

/** Gifts not yet posted to a batch (the review queue). */
export async function listQueue(provider: ProviderId): Promise<StagedGift[]> {
  const out: StagedGift[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = must(await supabase.from('external_transactions').select('*')
      .eq('church_id', requireChurchId()).eq('provider', provider).is('donation_id', null)
      .order('gift_date').order('external_id').range(from, from + 999)) as ExternalTransactionRow[];
    out.push(...rows.map(fromRow));
    if (rows.length < 1000) return out;
  }
}

export async function countQueue(): Promise<number> {
  const { count, error } = await supabase.from('external_transactions').select('id', { count: 'exact', head: true })
    .eq('church_id', requireChurchId()).is('donation_id', null).eq('ignored', false).eq('status', 'succeeded');
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function setIgnored(ids: string[], ignored: boolean): Promise<void> {
  try { must(await supabase.from('external_transactions').update({ ignored }).in('id', ids)); }
  finally { notifyChange(); }
}

export async function listGiverLinks(provider: ProviderId): Promise<Map<string, string>> {
  const rows = must(await supabase.from('giver_external_ids').select('external_id, giver_id')
    .eq('church_id', requireChurchId()).eq('provider', provider)) as { external_id: string; giver_id: string }[];
  return new Map(rows.map(r => [r.external_id, r.giver_id]));
}

export async function listFundMap(provider: ProviderId): Promise<Map<string, string>> {
  const rows = must(await supabase.from('external_fund_map').select('external_key, fund_id')
    .eq('church_id', requireChurchId()).eq('provider', provider)) as { external_key: string; fund_id: string }[];
  return new Map(rows.map(r => [r.external_key, r.fund_id]));
}

/** Post gifts as one open batch. The batch still needs two-person sign-off. */
export async function postGifts(
  provider: ProviderId,
  ids: string[],
  resolutions: { id: string; giver_id: string; fund_id: string }[],
  batchDate?: string,
): Promise<PostResult> {
  try {
    return must(await supabase.rpc('post_external_batch', {
      p_church_id: requireChurchId(), p_provider: provider, p_ids: ids,
      p_batch_date: batchDate ?? null, p_resolutions: resolutions,
    })) as unknown as PostResult;
  } finally { notifyChange(); }
}

export interface BatchProviderSummary { count: number; gross: number; fees: number; net: number; refunded: number }

/** Gross, fees and expected bank deposit for a provider batch. */
export async function getBatchProviderSummary(batchId: string): Promise<BatchProviderSummary | null> {
  const dons = must(await supabase.from('donations').select('id').eq('batch_id', batchId)) as { id: string }[];
  if (dons.length === 0) return null;
  const rows: { amount: number; fee: number; status: string }[] = [];
  for (let i = 0; i < dons.length; i += 200) {
    rows.push(...(must(await supabase.from('external_transactions').select('amount, fee, status')
      .in('donation_id', dons.slice(i, i + 200).map(d => d.id))) as { amount: number; fee: number; status: string }[]));
  }
  if (rows.length === 0) return null;
  const gross = rows.reduce((s, r) => s + Number(r.amount), 0);
  const fees = rows.reduce((s, r) => s + Number(r.fee), 0);
  return {
    count: rows.length, gross: round(gross), fees: round(fees), net: round(gross - fees),
    refunded: rows.filter(r => r.status === 'refunded').length,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Automatic intake (mailbox)
// ---------------------------------------------------------------------------
export async function getMailboxSettings(): Promise<MailboxSettingsView | null> {
  return must(await supabase.rpc('get_mailbox_settings', { p_church_id: requireChurchId() })) as unknown as MailboxSettingsView | null;
}

/** Save the connection. `secret` is write-only: leave it empty to keep the saved one. */
export async function saveMailboxSettings(settings: Partial<MailboxSettingsView>, secret?: string): Promise<void> {
  try {
    must(await supabase.rpc('set_mailbox_settings', {
      p_church_id: requireChurchId(), p_settings: settings as never, p_secret: secret || null,
    }));
  } finally { notifyChange(); }
}

export interface MailboxRunResult { ok: boolean; detail?: string; error?: string; summary?: Record<string, unknown> }

/** 'test' connects and counts; 'poll' reads new mail now (the schedule does this every 10 minutes). */
export async function runMailbox(action: 'test' | 'poll'): Promise<MailboxRunResult> {
  try { return await invokeFunction<MailboxRunResult>('mailbox-poll', { action, church_id: requireChurchId() }); }
  finally { if (action === 'poll') notifyChange(); }
}

/** Re-run automatic matching/posting (e.g. after fixing the Giver Registry). */
export async function runAutoPost(provider: ProviderId): Promise<{ posted: number; held_for_review: number; batches: Record<string, number> }> {
  try {
    return must(await supabase.rpc('auto_post_external', { p_church_id: requireChurchId(), p_provider: provider })) as never;
  } finally { notifyChange(); }
}

export async function listInbox(limit = 50): Promise<InboxMessage[]> {
  const rows = must(await supabase.from('inbound_messages')
    .select('id, source, received_at, from_address, subject, status, reason, external_transaction_id, created_at')
    .eq('church_id', requireChurchId()).order('created_at', { ascending: false }).limit(limit)) as Omit<InboundMessageRow, 'raw'>[];
  return rows.map(r => ({
    id: r.id, source: r.source, receivedAt: r.received_at ?? undefined, from: r.from_address ?? undefined,
    subject: r.subject ?? undefined, status: r.status, reason: r.reason ?? undefined,
    externalTransactionId: r.external_transaction_id ?? undefined, createdAt: r.created_at,
  }));
}

/** The original email, exactly as received. */
export async function getInboundRaw(id: string): Promise<string> {
  const row = must(await supabase.from('inbound_messages').select('raw').eq('id', id).single()) as { raw: string };
  return row.raw;
}
