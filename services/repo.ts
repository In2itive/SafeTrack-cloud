/**
 * SafeTrack data layer. Every screen talks to Supabase through here.
 *
 * It maps database rows (snake_case, uuid ids, lowercase enums) to the app's
 * existing types in ../types.ts, so the screens keep working with the same
 * shapes they had under Dexie. Row-level security in the database decides what
 * each user can see; nothing here is a security boundary.
 */
import { useEffect, useRef, useState } from 'react';
import { supabase, secondTellerClient } from './supabase';
import type {
  BatchRow, BatchSourceDb, DonationRow, FundRow, GiverRow, InternalAccountRow,
  MemberRole, PaymentMethodDb, SettingsRow, SignoffRow,
} from './database.types';
import {
  AppSettings, Batch, BatchSource, BatchStatus, Donation, DonationSplit, FundEntity,
  Giver, InternalAccount, PaymentMethod, SmtpSettings, User, UserRole,
} from '../types';
import { parseGiversCSV } from './csv';

// ---------------------------------------------------------------------------
// Current church
// ---------------------------------------------------------------------------
let currentChurchId: string | null = null;
export const setCurrentChurch = (id: string | null) => { currentChurchId = id; };
const churchId = (): string => {
  if (!currentChurchId) throw new Error('No church selected');
  return currentChurchId;
};

// ---------------------------------------------------------------------------
// Change notifications (replaces Dexie's useLiveQuery)
// ---------------------------------------------------------------------------
const listeners = new Set<() => void>();
export const notifyChange = () => listeners.forEach(l => l());

/** Runs `fn` now, again whenever `deps` change, and again after any write through this module. */
export function useLive<T>(fn: () => Promise<T>, deps: unknown[] = []): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  const seq = useRef(0);
  useEffect(() => {
    let active = true;
    const run = () => {
      const mine = ++seq.current;
      fn().then(v => { if (active && mine === seq.current) setValue(v); })
          .catch(err => console.error('Live query failed:', err));
    };
    run();
    listeners.add(run);
    return () => { active = false; listeners.delete(run); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/** Throw on Supabase errors with a readable message. */
function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

// Writes go through this so every screen refreshes afterwards.
async function write<T>(op: () => Promise<T>): Promise<T> {
  try { return await op(); } finally { notifyChange(); }
}

// ---------------------------------------------------------------------------
// Enum mapping
// ---------------------------------------------------------------------------
const roleFromDb: Record<MemberRole, UserRole> = {
  administrator: UserRole.Administrator, treasurer: UserRole.Treasurer,
  envelope: UserRole.Envelope, teller: UserRole.Teller,
};
export const roleToDb = (r: UserRole): MemberRole =>
  (Object.entries(roleFromDb).find(([, v]) => v === r)?.[0] ?? 'teller') as MemberRole;

const methodFromDb: Record<PaymentMethodDb, PaymentMethod> = {
  cash: PaymentMethod.Cash, cheque: PaymentMethod.Cheque, e_transfer: PaymentMethod.ETransfer,
};
const methodToDb = (m: PaymentMethod): PaymentMethodDb =>
  m === PaymentMethod.Cash ? 'cash' : m === PaymentMethod.ETransfer ? 'e_transfer' : 'cheque';

const sourceFromDb: Record<BatchSourceDb, BatchSource> = {
  in_person: BatchSource.InPerson, e_transfer: BatchSource.ETransfer, pushpay: BatchSource.PushPay,
};
const sourceToDb = (s?: BatchSource): BatchSourceDb =>
  s === BatchSource.ETransfer ? 'e_transfer' : s === BatchSource.PushPay ? 'pushpay' : 'in_person';

// ---------------------------------------------------------------------------
// Membership / church setup
// ---------------------------------------------------------------------------
export interface Membership { churchId: string; churchName: string; user: User }

export async function getMembership(client = supabase): Promise<Membership | null> {
  const { data: auth } = await client.auth.getUser();
  if (!auth.user) return null;
  const rows = must(await client.from('church_members')
    .select('church_id, role, display_name, is_active, churches(name)')
    .eq('user_id', auth.user.id).eq('is_active', true).limit(1));
  const m = (rows as any[])[0];
  if (!m) return null;
  return {
    churchId: m.church_id,
    churchName: m.churches?.name ?? '',
    user: { id: auth.user.id, email: auth.user.email ?? '', name: m.display_name, role: roleFromDb[m.role as MemberRole], isActive: m.is_active },
  };
}

export async function createChurch(name: string, displayName: string): Promise<string> {
  return write(async () => must(await supabase.rpc('create_church', { p_name: name, p_display_name: displayName })) as string);
}

// ---------------------------------------------------------------------------
// Givers
// ---------------------------------------------------------------------------
const giverFromRow = (g: GiverRow): Giver => ({
  id: g.id, envelopeNumber: g.envelope_number, name: g.name, name2: g.name2 ?? undefined,
  email: g.email ?? undefined, email2: g.email2 ?? undefined,
  address1: g.address1 ?? undefined, address2: g.address2 ?? undefined, address3: g.address3 ?? undefined,
  eTransferId: g.etransfer_id ?? undefined, eTransferId2: g.etransfer_id2 ?? undefined,
  pushPayId: g.pushpay_id ?? undefined, isSystem: g.is_system,
});
const giverToRow = (g: Partial<Giver>) => ({
  name: g.name?.trim(), name2: g.name2 || null, email: g.email || null, email2: g.email2 || null,
  address1: g.address1 || null, address2: g.address2 || null, address3: g.address3 || null,
  etransfer_id: g.eTransferId || null, etransfer_id2: g.eTransferId2 || null, pushpay_id: g.pushPayId || null,
});

/** Regular givers only (the registry). System givers come from getSystemGivers(). */
export async function listGivers(): Promise<Giver[]> {
  const rows = must(await supabase.from('givers').select('*')
    .eq('church_id', churchId()).eq('is_system', false).order('envelope_number'));
  return (rows as GiverRow[]).map(giverFromRow);
}

export async function getGivers(ids: string[]): Promise<Giver[]> {
  if (ids.length === 0) return [];
  const rows = must(await supabase.from('givers').select('*').in('id', ids));
  return (rows as GiverRow[]).map(giverFromRow);
}

export interface SystemGivers { loose: Giver; internal: Giver }
export async function getSystemGivers(): Promise<SystemGivers> {
  const rows = (must(await supabase.from('givers').select('*')
    .eq('church_id', churchId()).eq('is_system', true)) as GiverRow[]).map(giverFromRow);
  const loose = rows.find(g => g.envelopeNumber === 0);
  const internal = rows.find(g => g.envelopeNumber === 1);
  if (!loose || !internal) throw new Error('System givers missing for this church');
  return { loose, internal };
}

/** Insert a giver. Omit envelopeNumber to have the database assign the next one. */
export async function addGiver(g: Omit<Giver, 'id'> & { envelopeNumber?: number }): Promise<Giver> {
  return write(async () => {
    const row = must(await supabase.from('givers').insert({
      church_id: churchId(), ...giverToRow(g),
      ...(g.envelopeNumber ? { envelope_number: g.envelopeNumber } : {}),
    }).select('*').single());
    return giverFromRow(row as GiverRow);
  });
}

export async function updateGiver(id: string, g: Partial<Giver>): Promise<void> {
  await write(async () => {
    const patch: Record<string, unknown> = giverToRow(g);
    if (g.envelopeNumber) patch.envelope_number = g.envelopeNumber;
    must(await supabase.from('givers').update(patch).eq('id', id));
  });
}

/** CSV import: rows are matched by envelope number (update) or added (insert). Nothing is deleted. */
export async function importGiversCSV(csv: string): Promise<{ added: number; updated: number }> {
  const incoming = parseGiversCSV(csv).filter(g => g.envelopeNumber >= 2);
  const existing = new Map((await listGivers()).map(g => [g.envelopeNumber, g]));
  let added = 0, updated = 0;
  await write(async () => {
    for (const g of incoming) {
      const match = existing.get(g.envelopeNumber);
      if (match?.id) {
        must(await supabase.from('givers').update(giverToRow(g)).eq('id', match.id));
        updated++;
      } else {
        must(await supabase.from('givers').insert({ church_id: churchId(), envelope_number: g.envelopeNumber, ...giverToRow(g) }));
        added++;
      }
    }
  });
  return { added, updated };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const settingsFromRow = (s: SettingsRow): AppSettings => ({
  nextEnvelopeNumber: s.next_envelope_number,
  allowAdminSoloFinalize: s.allow_admin_solo_finalize,
  accountingRecipients: s.accounting_recipients.join(', '),
  envelopeRecipients: s.envelope_recipients.join(', '),
  depositRecipients: s.deposit_recipients.join(', '),
  bankLogo: s.bank_logo ?? undefined, accountOf: s.account_of ?? undefined,
  branchNumber: s.branch_number ?? undefined, accountNumber: s.account_number ?? undefined,
  churchLogo: s.church_logo ?? undefined,
  churchAddressLine1: s.church_address_line1 ?? undefined,
  churchAddressLine2: s.church_address_line2 ?? undefined,
  churchAddressLine3: s.church_address_line3 ?? undefined,
});
const splitList = (v?: string) => (v ?? '').split(',').map(x => x.trim()).filter(Boolean);

export async function getSettings(): Promise<AppSettings> {
  const row = must(await supabase.from('church_settings').select('*').eq('church_id', churchId()).single());
  return settingsFromRow(row as SettingsRow);
}

export async function getNextEnvelopeNumber(): Promise<number> {
  return (await getSettings()).nextEnvelopeNumber;
}

export async function updateSettings(u: Partial<AppSettings>): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (u.nextEnvelopeNumber !== undefined) patch.next_envelope_number = u.nextEnvelopeNumber;
  if (u.allowAdminSoloFinalize !== undefined) patch.allow_admin_solo_finalize = u.allowAdminSoloFinalize;
  if (u.accountingRecipients !== undefined) patch.accounting_recipients = splitList(u.accountingRecipients);
  if (u.envelopeRecipients !== undefined) patch.envelope_recipients = splitList(u.envelopeRecipients);
  if (u.depositRecipients !== undefined) patch.deposit_recipients = splitList(u.depositRecipients);
  const plain: [keyof AppSettings, string][] = [
    ['bankLogo', 'bank_logo'], ['accountOf', 'account_of'], ['branchNumber', 'branch_number'],
    ['accountNumber', 'account_number'], ['churchLogo', 'church_logo'],
    ['churchAddressLine1', 'church_address_line1'], ['churchAddressLine2', 'church_address_line2'],
    ['churchAddressLine3', 'church_address_line3'],
  ];
  for (const [k, col] of plain) if (u[k] !== undefined) patch[col] = u[k] || null;
  if (Object.keys(patch).length === 0) return;
  await write(async () => { must(await supabase.from('church_settings').update(patch).eq('church_id', churchId())); });
}

export async function getSmtpSettings(): Promise<SmtpSettings | null> {
  const rows = must(await supabase.rpc('get_smtp_settings', { p_church_id: churchId() })) as any[];
  const r = rows?.[0];
  return r ? { host: r.host, port: r.port, username: r.username, fromAddress: r.from_address, hasPassword: r.has_password } : null;
}

/** password: undefined/empty keeps the stored one. */
export async function setSmtpSettings(s: { host: string; port: number; username: string; fromAddress: string; password?: string }): Promise<void> {
  await write(async () => {
    must(await supabase.rpc('set_smtp_settings', {
      p_church_id: churchId(), p_host: s.host, p_port: s.port, p_username: s.username,
      p_password: s.password ? s.password : null, p_from_address: s.fromAddress,
    }));
  });
}

// ---------------------------------------------------------------------------
// Funds & internal accounts
// ---------------------------------------------------------------------------
export async function listFunds(): Promise<FundEntity[]> {
  const rows = must(await supabase.from('funds').select('*').eq('church_id', churchId()).order('sort_order').order('name'));
  return (rows as FundRow[]).map(f => ({ id: f.id, name: f.name, isSystem: f.is_system, isActive: f.is_active }));
}
export async function addFund(name: string): Promise<void> {
  await write(async () => { must(await supabase.from('funds').insert({ church_id: churchId(), name: name.trim(), sort_order: 100 })); });
}
export async function setFundActive(id: string, isActive: boolean): Promise<void> {
  await write(async () => { must(await supabase.from('funds').update({ is_active: isActive }).eq('id', id)); });
}

export async function listInternalAccounts(): Promise<InternalAccount[]> {
  const rows = must(await supabase.from('internal_accounts').select('*').eq('church_id', churchId()).order('code'));
  return (rows as InternalAccountRow[]).map(a => ({ id: a.id, name: a.code, isActive: a.is_active }));
}
export async function addInternalAccount(code: string): Promise<InternalAccount> {
  return write(async () => {
    const a = must(await supabase.from('internal_accounts').insert({ church_id: churchId(), code: code.trim() }).select('*').single()) as InternalAccountRow;
    return { id: a.id, name: a.code, isActive: a.is_active };
  });
}
export async function setInternalAccountActive(id: string, isActive: boolean): Promise<void> {
  await write(async () => { must(await supabase.from('internal_accounts').update({ is_active: isActive }).eq('id', id)); });
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------
function assembleBatch(b: BatchRow, total: { total_amount: number | null; item_count: number | null } | undefined,
                       signoffs: SignoffRow[], newGiverIds: string[]): Batch {
  const mine = signoffs.filter(s => s.batch_id === b.id);
  // Original count: the tellers who signed revision 1, finalizer first.
  const r1 = mine.filter(s => s.revision === 1).sort((x, y) => y.signed_at.localeCompare(x.signed_at));
  const adjusters = [...new Set(mine.filter(s => s.revision > 1 && s.role === 'administrator')
    .sort((x, y) => x.signed_at.localeCompare(y.signed_at)).map(s => s.display_name))];
  const finalizedBy = b.legacy_finalized_by?.length ? b.legacy_finalized_by : r1.map(s => s.display_name);
  return {
    id: b.id,
    batchNumber: b.batch_number,
    date: b.batch_date,
    status: b.status === 'finalized' ? BatchStatus.Finalized : BatchStatus.Open,
    source: sourceFromDb[b.source],
    totalAmount: Number(total?.total_amount ?? 0),
    itemCount: Number(total?.item_count ?? 0),
    newGiverIds,
    finalizedBy: finalizedBy.length ? finalizedBy : undefined,
    adjustedBy: adjusters.length ? adjusters : undefined,
    revision: b.revision,
  };
}

async function loadBatches(filter?: string): Promise<Batch[]> {
  let q = supabase.from('batches').select('*').eq('church_id', churchId());
  if (filter) q = q.eq('id', filter);
  const batches = must(await q.order('batch_date', { ascending: false }).order('created_at', { ascending: false })) as BatchRow[];
  if (batches.length === 0) return [];
  const ids = batches.map(b => b.id);
  const [totals, signoffs, newGivers] = await Promise.all([
    supabase.from('batch_totals').select('*').in('batch_id', ids),
    supabase.from('batch_signoffs').select('*').in('batch_id', ids),
    supabase.from('givers').select('id, created_in_batch_id').in('created_in_batch_id', ids),
  ]);
  const totalMap = new Map((must(totals) as any[]).map(t => [t.batch_id, t]));
  const so = must(signoffs) as SignoffRow[];
  const ng = must(newGivers) as { id: string; created_in_batch_id: string }[];
  return batches.map(b => assembleBatch(b, totalMap.get(b.id), so, ng.filter(g => g.created_in_batch_id === b.id).map(g => g.id)));
}

export const listBatches = () => loadBatches();
export async function getBatch(id: string): Promise<Batch | undefined> {
  return (await loadBatches(id))[0];
}

export async function deleteBatch(id: string): Promise<void> {
  await write(async () => { must(await supabase.from('batches').delete().eq('id', id)); });
}

// ---------------------------------------------------------------------------
// Donations
// ---------------------------------------------------------------------------
const DONATION_SELECT = '*, donation_splits(amount, funds(name), internal_accounts(code))';

function donationFromRow(d: DonationRow & { donation_splits?: any[] }, batchDate?: string): Donation {
  const splits: DonationSplit[] = (d.donation_splits ?? []).map(s => ({
    fund: s.funds?.name ?? 'Unknown',
    amount: Number(s.amount),
    ...(s.internal_accounts?.code ? { internalAccount: s.internal_accounts.code } : {}),
  }));
  return {
    id: d.id, transactionNumber: (d as any).transaction_number ?? undefined,
    giverId: d.giver_id, batchId: d.batch_id, amount: Number(d.amount),
    date: batchDate ?? d.created_at.slice(0, 10),
    paymentMethod: methodFromDb[d.payment_method],
    splits: splits.length ? splits : [{ fund: 'General', amount: Number(d.amount) }],
    chequeNumber: d.cheque_number ?? undefined,
    notes: d.notes ?? undefined,
    cashCounts: (d.cash_counts as Record<string, number> | null) ?? undefined,
  };
}

export async function listDonations(batchId: string): Promise<Donation[]> {
  const [rows, batch] = await Promise.all([
    supabase.from('donations').select(DONATION_SELECT).eq('batch_id', batchId).order('sort_order'),
    supabase.from('batches').select('batch_date').eq('id', batchId).maybeSingle(),
  ]);
  const date = (must(batch) as any)?.batch_date as string | undefined;
  return (must(rows) as any[]).map(r => donationFromRow(r, date));
}

export interface YearSummary { year: number; total: number; count: number; batches: number; byMonth: number[] }

/** Year-to-date totals, computed by the database (batch-date year). */
export async function getYearSummary(year: number): Promise<YearSummary> {
  const r = must(await supabase.rpc('dashboard_summary', { p_church_id: churchId(), p_year: year })) as any;
  return { year: r.year, total: Number(r.total), count: Number(r.count), batches: Number(r.batches), byMonth: (r.by_month ?? []).map(Number) };
}

export interface RecentTransaction {
  transactionNumber: string;
  amount: number;
  method: PaymentMethod;
  giverName: string;
  envelopeNumber: number;
  batchNumber: string;
  batchDate: string;
  batchId: string;
}

/** Most recently entered transactions. */
export async function listRecentTransactions(limit = 8): Promise<RecentTransaction[]> {
  const rows = must(await supabase.from('donations')
    .select('transaction_number, amount, payment_method, batch_id, givers(name, envelope_number), batches(batch_number, batch_date)')
    .eq('church_id', churchId())
    .order('created_at', { ascending: false })
    .order('transaction_number', { ascending: false })
    .limit(limit)) as any[];
  return rows.map(r => ({
    transactionNumber: r.transaction_number, amount: Number(r.amount), method: methodFromDb[r.payment_method as PaymentMethodDb],
    giverName: r.givers?.name ?? 'Unknown', envelopeNumber: r.givers?.envelope_number ?? 0,
    batchNumber: r.batches?.batch_number ?? '', batchDate: r.batches?.batch_date ?? '', batchId: r.batch_id,
  }));
}

/** Every donation for the church (capped by the API at 1000 rows; prefer the functions above). */
export async function listAllDonations(): Promise<Donation[]> {
  const rows = must(await supabase.from('donations').select(`${DONATION_SELECT}, batches(batch_date)`)
    .eq('church_id', churchId()).limit(10000)) as any[];
  return rows.map(r => donationFromRow(r, r.batches?.batch_date));
}

export async function countGivers(): Promise<number> {
  const { count, error } = await supabase.from('givers').select('id', { count: 'exact', head: true })
    .eq('church_id', churchId()).eq('is_system', false);
  if (error) throw new Error(error.message);
  return count ?? 0;
}
export async function countBatches(): Promise<number> {
  const { count, error } = await supabase.from('batches').select('id', { count: 'exact', head: true }).eq('church_id', churchId());
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function deleteDonation(id: string): Promise<void> {
  // Splits cascade; RLS + the lock trigger refuse this on a finalized batch.
  await write(async () => { must(await supabase.from('donations').delete().eq('id', id)); });
}

// ---------------------------------------------------------------------------
// Saving a batch (one atomic call)
// ---------------------------------------------------------------------------
export interface BatchRowInput {
  donationId?: string;
  giverId: string;
  amount: number;
  method: PaymentMethod;
  chequeNumber?: string;
  notes?: string;
  splits: DonationSplit[];
  cashCounts?: Record<string, number>;
}

export async function saveBatch(input: {
  batchId?: string; date: string; source?: BatchSource;
  rows: BatchRowInput[]; deletedDonationIds: string[]; newGiverIds: string[];
}): Promise<{ batchId: string; donationIds: string[] }> {
  const [funds, accounts] = await Promise.all([listFunds(), listInternalAccounts()]);
  const fundId = new Map(funds.map(f => [f.name.toLowerCase(), f.id!]));
  const acctId = new Map(accounts.map(a => [a.name.toLowerCase(), a.id!]));

  // Internal account codes typed during entry that don't exist yet
  for (const code of new Set(input.rows.flatMap(r => r.splits.map(s => s.internalAccount?.trim()).filter(Boolean) as string[]))) {
    if (!acctId.has(code.toLowerCase())) {
      const a = await addInternalAccount(code);
      acctId.set(code.toLowerCase(), a.id!);
    }
  }

  const donations = input.rows.map(r => ({
    id: r.donationId ?? null,
    giver_id: r.giverId,
    amount: Math.round(r.amount * 100) / 100,
    payment_method: methodToDb(r.method),
    cheque_number: r.method === PaymentMethod.Cheque ? (r.chequeNumber ?? '') : '',
    notes: r.notes ?? '',
    cash_counts: r.method === PaymentMethod.Cash ? cleanCounts(r.cashCounts) : null,
    splits: r.splits.filter(s => s.amount).map(s => {
      const f = fundId.get(s.fund.toLowerCase());
      if (!f) throw new Error(`Unknown fund "${s.fund}"`);
      return {
        fund_id: f,
        internal_account_id: s.internalAccount ? acctId.get(s.internalAccount.trim().toLowerCase()) ?? null : null,
        amount: Math.round(s.amount * 100) / 100,
      };
    }),
  }));

  return write(async () => {
    const res = must(await supabase.rpc('save_batch', {
      p_church_id: churchId(),
      p_batch: input.batchId
        ? { id: input.batchId, batch_date: input.date, source: sourceToDb(input.source) }
        : { batch_date: input.date, source: sourceToDb(input.source) },  // number assigned by the server
      p_donations: donations,
      p_deleted_ids: input.deletedDonationIds,
      p_new_giver_ids: input.newGiverIds,
    })) as { batch_id: string; donation_ids: string[] };
    return { batchId: res.batch_id, donationIds: res.donation_ids };
  });
}

/** Drop zero quantities so an unchanged count compares equal on re-save. */
function cleanCounts(c?: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(c ?? {})) if (v && v > 0) out[String(Number(k))] = Math.round(v);
  return out;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
/** The second teller's own session signs off on the batch. */
export async function signAsSecondTeller(batchId: string): Promise<void> {
  must(await secondTellerClient.rpc('sign_batch', { p_batch_id: batchId }));
}

export async function finalizeBatch(batchId: string, cashCounts: Record<string, number>, chequeCount: number, chequeTotal: number): Promise<void> {
  await write(async () => {
    must(await supabase.rpc('finalize_batch', {
      p_batch_id: batchId, p_cash_counts: cleanCounts(cashCounts),
      p_cheque_count: chequeCount, p_cheque_total: Math.round(chequeTotal * 100) / 100,
    }));
  });
}

export async function unlockBatch(batchId: string, reason: string): Promise<void> {
  await write(async () => { must(await supabase.rpc('unlock_batch', { p_batch_id: batchId, p_reason: reason })); });
}

// ---------------------------------------------------------------------------
// Members: handled by the `members` Edge Function (it needs the Auth admin API)
// ---------------------------------------------------------------------------
async function fn<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    // Surface the function's own error message when there is one
    const ctx: any = (error as any).context;
    const msg = ctx?.json ? (await ctx.json().catch(() => null))?.error : undefined;
    throw new Error(msg || error.message);
  }
  return data as T;
}
export { fn as invokeFunction };

export async function listMembers(): Promise<User[]> {
  const { members } = await fn<{ members: any[] }>('members', { action: 'list', church_id: churchId() });
  return members.map(m => ({ id: m.user_id, email: m.email, name: m.display_name, role: roleFromDb[m.role as MemberRole], isActive: m.is_active }));
}

export async function addMember(m: { email: string; name: string; role: UserRole; password: string }): Promise<void> {
  await write(() => fn('members', {
    action: 'create', church_id: churchId(), email: m.email, display_name: m.name, role: roleToDb(m.role), password: m.password,
  }));
}

export async function updateMember(userId: string, u: { name?: string; role?: UserRole; password?: string }): Promise<void> {
  await write(() => fn('members', {
    action: 'update', church_id: churchId(), user_id: userId,
    display_name: u.name, role: u.role ? roleToDb(u.role) : undefined, password: u.password || undefined,
  }));
}

export async function removeMember(userId: string): Promise<void> {
  await write(() => fn('members', { action: 'remove', church_id: churchId(), user_id: userId }));
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------
/** A readable export of everything this church owns (no secrets, no passwords). */
export async function exportBackup(): Promise<string> {
  const id = churchId();
  const tables = ['churches', 'church_members', 'church_settings', 'funds', 'internal_accounts', 'givers',
                  'batches', 'donations', 'donation_splits', 'batch_signoffs', 'batch_finalizations', 'batch_unlocks'];
  const out: Record<string, unknown> = { format: 'safetrack-cloud-backup', version: 1, exported_at: new Date().toISOString() };
  for (const t of tables) {
    out[t] = must(await supabase.from(t).select('*').eq(t === 'churches' ? 'id' : 'church_id', id).limit(100000));
  }
  return JSON.stringify(out, null, 2);
}

export async function importLegacyBackup(json: string): Promise<Record<string, number>> {
  let data: unknown;
  try { data = JSON.parse(json); } catch { throw new Error('That file is not valid JSON'); }
  return write(async () => must(await supabase.rpc('import_legacy_backup', { p_church_id: churchId(), p_data: data })) as Record<string, number>);
}

/** Short fallback reference when a batch number isn't loaded yet. */
export const shortId = (id?: string | null) => (id ? id.slice(0, 8).toUpperCase() : '');

/** The batch number people see and quote (YYYY####). */
export const batchLabel = (b?: { batchNumber?: string; id?: string } | null) => b?.batchNumber || shortId(b?.id);
