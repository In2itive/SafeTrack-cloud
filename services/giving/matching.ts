/**
 * Suggest a giver and a fund for each staged gift. Provider-agnostic.
 * Order of trust: envelope # → remembered link → provider ID on the giver → email → name.
 * A suggestion is only made when exactly one giver fits.
 */
import type { FundEntity, Giver } from '../../types';
import type { GiftRecord } from './types';

export type GiverReason = 'envelope' | 'remembered' | 'provider id' | 'email' | 'name';
export type FundReason = 'remembered' | 'name' | 'memo' | 'guess';

export interface GiverSuggestion { giverId?: string; reason?: GiverReason; candidates?: string[] }
export interface FundSuggestion { fundId?: string; reason?: FundReason }

export const normName = (s: string) =>
  s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** All the ways a registry name could be written by a payer. */
export function nameKeys(name?: string): string[] {
  if (!name?.trim()) return [];
  const keys = new Set<string>();
  const add = (s: string) => { const n = normName(s); if (n) keys.add(n); };
  const raw = name.trim();
  add(raw);
  // "Smith, John" -> "John Smith"
  const comma = raw.match(/^([^,]+),\s*(.+)$/);
  if (comma) add(`${comma[2]} ${comma[1]}`);
  const plain = comma ? `${comma[2]} ${comma[1]}` : raw;
  // "John & Mary Smith" / "John and Mary Smith" -> "John Smith", "Mary Smith"
  const joint = plain.match(/^(.+?)\s+(?:&|and)\s+(.+)$/i);
  if (joint) {
    const second = joint[2].trim();
    const last = second.split(/\s+/).slice(-1)[0];
    add(second);
    add(joint[1].includes(' ') ? joint[1] : `${joint[1]} ${last}`);
  }
  return [...keys];
}

export interface MatchContext {
  givers: Giver[];                       // regular givers (not system)
  giverLinks: Map<string, string>;       // provider payer id -> giver id
  funds: FundEntity[];                   // active funds
  fundMap: Map<string, string>;          // lower(fund key) -> fund id
}

export function buildIndexes(ctx: MatchContext) {
  const byEmail = new Map<string, Set<string>>();
  const byName = new Map<string, Set<string>>();
  const byProviderId = new Map<string, Set<string>>();
  const byEnvelope = new Map<number, string>();
  const put = (m: Map<string, Set<string>>, k: string | undefined, id: string) => {
    const key = k?.trim().toLowerCase();
    if (!key) return;
    if (!m.has(key)) m.set(key, new Set());
    m.get(key)!.add(id);
  };
  for (const g of ctx.givers) {
    if (!g.id) continue;
    byEnvelope.set(g.envelopeNumber, g.id);
    [g.email, g.email2, g.eTransferId, g.eTransferId2].forEach(e => { if (e?.includes('@')) put(byEmail, e, g.id!); });
    put(byProviderId, g.pushPayId, g.id);
    [...nameKeys(g.name), ...nameKeys(g.name2)].forEach(k => put(byName, k, g.id!));
  }
  return { byEmail, byName, byProviderId, byEnvelope };
}

export function suggestGiver(gift: GiftRecord, ctx: MatchContext, idx: ReturnType<typeof buildIndexes>): GiverSuggestion {
  if (gift.payerEnvelope !== undefined) {
    const byEnv = idx.byEnvelope.get(gift.payerEnvelope);
    if (byEnv) return { giverId: byEnv, reason: 'envelope' };
  }
  if (gift.payerExternalId) {
    const linked = ctx.giverLinks.get(gift.payerExternalId);
    if (linked && ctx.givers.some(g => g.id === linked)) return { giverId: linked, reason: 'remembered' };
  }
  const one = (s?: Set<string>) => (s && s.size === 1 ? [...s][0] : undefined);
  const viaId = one(idx.byProviderId.get(gift.payerExternalId?.toLowerCase() ?? ''))
             ?? one(idx.byProviderId.get(gift.payerEmail?.toLowerCase() ?? ''));
  if (viaId) return { giverId: viaId, reason: 'provider id' };

  const viaEmail = one(idx.byEmail.get(gift.payerEmail?.toLowerCase() ?? ''));
  if (viaEmail) return { giverId: viaEmail, reason: 'email' };

  const names = new Set<string>([
    ...nameKeys(gift.payerName),
    ...nameKeys([gift.payerFirstName, gift.payerLastName].filter(Boolean).join(' ')),
  ]);
  const hits = new Set<string>();
  names.forEach(n => idx.byName.get(n)?.forEach(id => hits.add(id)));
  if (hits.size === 1) return { giverId: [...hits][0], reason: 'name' };
  if (hits.size > 1) return { candidates: [...hits] };
  return {};
}

export const fundKeyOf = (gift: Pick<GiftRecord, 'fundKey' | 'fundName'>) =>
  (gift.fundKey ?? gift.fundName ?? '').trim().toLowerCase();

export function suggestFund(gift: GiftRecord, ctx: MatchContext): FundSuggestion {
  const key = fundKeyOf(gift);
  const active = new Set(ctx.funds.map(f => f.id));
  const remembered = key ? ctx.fundMap.get(key) : undefined;
  if (remembered && active.has(remembered)) return { fundId: remembered, reason: 'remembered' };
  const names = [gift.fundName, gift.fundKey].filter(Boolean).map(s => s!.trim().toLowerCase());
  const exact = ctx.funds.find(f => names.includes(f.name.trim().toLowerCase()));
  if (exact) return { fundId: exact.id, reason: 'name' };
  // No fund field (e-Transfers): look for exactly one fund named in the memo
  if (!key && gift.memo) {
    const memo = ` ${normName(gift.memo)} `;
    const hits = ctx.funds.filter(f => f.name.toLowerCase() !== 'internal' && memo.includes(` ${normName(f.name)} `));
    if (hits.length === 1) return { fundId: hits[0].id, reason: 'memo' };
  }
  const text = `${key} ${gift.fundName ?? ''} ${key ? '' : gift.memo ?? ''}`.toLowerCase();
  if (!key || /tithe|offering|general|\bgen\b|most needed/.test(text)) {
    const general = ctx.funds.find(f => f.name.toLowerCase() === 'general');
    if (general) return { fundId: general.id, reason: 'guess' };
  }
  return {};
}

/** "Mary Jones" from whatever payer fields the provider sent. */
export const payerLabel = (g: Pick<GiftRecord, 'payerName' | 'payerFirstName' | 'payerLastName' | 'payerEmail' | 'payerExternalId' | 'payerEnvelope'>) =>
  g.payerName || [g.payerFirstName, g.payerLastName].filter(Boolean).join(' ') || g.payerEmail
  || (g.payerEnvelope !== undefined ? `Envelope #${g.payerEnvelope}` : '') || g.payerExternalId || 'Unknown payer';

/** True when the provider gave us something a person could be identified by. */
export const hasPayerIdentity = (g: Pick<GiftRecord, 'payerName' | 'payerFirstName' | 'payerLastName' | 'payerEmail'>) =>
  !!(g.payerName || g.payerFirstName || g.payerLastName || g.payerEmail);
