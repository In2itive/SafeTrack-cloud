/** Data access for online giving. Provider-agnostic. */
import { supabase } from '../supabase';
import { notifyChange, requireChurchId } from '../repo';
import type { ExternalTransactionRow } from '../database.types';
import type { GiftRecord, PostResult, ProviderId, StagedGift, StageResult } from './types';

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
