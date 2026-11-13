// Database types for SafeTrack Cloud. Row shapes and RPC signatures match the
// output of `supabase gen types` for project safetrack-cloud-dev; Insert and
// Update are derived. Regenerate/update when migrations change.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type Table<R, Required extends keyof R = never> = {
  Row: R;
  Insert: Partial<R> & Pick<R, Required>;
  Update: Partial<R>;
  Relationships: [];
};

export type MemberRole = 'administrator' | 'treasurer' | 'envelope' | 'teller';
export type BatchStatusDb = 'open' | 'finalized';
export type BatchSourceDb = 'in_person' | 'e_transfer' | 'pushpay' | 'stripe';
export type PaymentMethodDb = 'cash' | 'cheque' | 'e_transfer' | 'card' | 'bank_debit' | 'online';

export interface ChurchRow { id: string; name: string; created_at: string; created_by: string | null }
export interface MemberRow {
  church_id: string; user_id: string; role: MemberRole; display_name: string;
  is_active: boolean; created_at: string;
}
export interface SettingsRow {
  church_id: string; next_envelope_number: number; allow_admin_solo_finalize: boolean;
  accounting_recipients: string[]; envelope_recipients: string[]; deposit_recipients: string[];
  bank_logo: string | null; account_of: string | null; branch_number: string | null; account_number: string | null;
  church_logo: string | null; church_address_line1: string | null; church_address_line2: string | null;
  church_address_line3: string | null; updated_at: string;
}
export interface FundRow { id: string; church_id: string; name: string; is_system: boolean; is_active: boolean; sort_order: number; created_at: string }
export interface InternalAccountRow { id: string; church_id: string; code: string; is_active: boolean; created_at: string }
export interface GiverRow {
  id: string; church_id: string; envelope_number: number; name: string; name2: string | null;
  email: string | null; email2: string | null; address1: string | null; address2: string | null; address3: string | null;
  etransfer_id: string | null; etransfer_id2: string | null; pushpay_id: string | null;
  is_system: boolean; created_in_batch_id: string | null; created_at: string; updated_at: string;
}
export interface BatchRow {
  id: string; church_id: string; batch_number: string; batch_date: string; status: BatchStatusDb;
  source: BatchSourceDb; revision: number; created_by: string | null; created_at: string;
  finalized_at: string | null; content_changed_at: string; legacy_finalized_by: string[] | null;
  legacy_batch_number: string | null; last_txn_seq: number;
}
export interface DonationRow {
  id: string; church_id: string; batch_id: string; giver_id: string; amount: number;
  payment_method: PaymentMethodDb; cheque_number: string | null; notes: string | null;
  cash_counts: Json | null; sort_order: number; created_at: string; transaction_number: string;
}
export interface SplitRow { id: string; church_id: string; donation_id: string; fund_id: string; internal_account_id: string | null; amount: number }
export interface SignoffRow {
  id: string; church_id: string; batch_id: string; revision: number; user_id: string;
  display_name: string; role: MemberRole; signed_at: string;
}
export interface AuditRow {
  id: number; church_id: string; table_name: string; record_id: string | null; action: string;
  actor_id: string | null; actor_name: string | null; at: string; old_data: Json | null; new_data: Json | null;
}
export interface BatchTotalsRow { batch_id: string | null; church_id: string | null; total_amount: number | null; item_count: number | null }

export type GiftStatusDb = 'succeeded' | 'pending' | 'failed' | 'refunded';
export interface ExternalTransactionRow {
  id: string; church_id: string; provider: BatchSourceDb; external_id: string; gift_date: string;
  amount: number; fee: number; currency: string | null; payment_method: PaymentMethodDb; status: GiftStatusDb;
  payer_external_id: string | null; payer_envelope: number | null; payer_first_name: string | null; payer_last_name: string | null;
  payer_name: string | null; payer_email: string | null; payer_phone: string | null; payer_address: string | null;
  fund_key: string | null; fund_name: string | null; memo: string | null; deposit_ref: string | null; raw: Json;
  giver_id: string | null; fund_id: string | null; ignored: boolean; donation_id: string | null;
  posted_at: string | null; staged_by: string | null; staged_at: string; updated_at: string;
  review_flags: string[]; match_flags: string[]; memo_raw: string | null; inbound_message_id: string | null; auto_posted: boolean;
}
export interface InboundMessageRow {
  id: string; church_id: string; provider: BatchSourceDb; source: string; message_key: string; received_at: string | null;
  from_address: string | null; subject: string | null; raw: string; status: 'staged' | 'duplicate' | 'skipped' | 'error';
  reason: string | null; external_transaction_id: string | null; created_at: string;
}
export interface GiverExternalIdRow { church_id: string; provider: BatchSourceDb; external_id: string; giver_id: string; updated_at: string }
export interface ExternalFundMapRow { church_id: string; provider: BatchSourceDb; external_key: string; fund_id: string; updated_at: string }

export type Database = {
  public: {
    Tables: {
      churches: Table<ChurchRow, 'name'>;
      church_members: Table<MemberRow, 'church_id' | 'user_id' | 'role' | 'display_name'>;
      church_settings: Table<SettingsRow, 'church_id'>;
      funds: Table<FundRow, 'church_id' | 'name'>;
      internal_accounts: Table<InternalAccountRow, 'church_id' | 'code'>;
      givers: Table<GiverRow, 'church_id' | 'name'>;
      batches: Table<BatchRow, 'church_id' | 'batch_number'>;
      donations: Table<DonationRow, 'church_id' | 'batch_id' | 'giver_id' | 'amount' | 'payment_method'>;
      donation_splits: Table<SplitRow, 'church_id' | 'donation_id' | 'fund_id' | 'amount'>;
      batch_signoffs: Table<SignoffRow>;
      batch_finalizations: Table<{ id: string; church_id: string; batch_id: string; revision: number; finalized_by: string; finalized_at: string; audit_cash_counts: Json; audit_cheque_count: number; audit_cheque_total: number; system_total: number }>;
      batch_unlocks: Table<{ id: string; church_id: string; batch_id: string; from_revision: number; unlocked_by: string; reason: string; unlocked_at: string }>;
      audit_log: Table<AuditRow>;
      external_transactions: Table<ExternalTransactionRow>;
      giver_external_ids: Table<GiverExternalIdRow>;
      external_fund_map: Table<ExternalFundMapRow>;
      inbound_messages: Table<InboundMessageRow>;
    };
    Views: {
      batch_totals: { Row: BatchTotalsRow; Relationships: [] };
    };
    Functions: {
      create_church: { Args: { p_name: string; p_display_name: string }; Returns: string };
      sign_batch: { Args: { p_batch_id: string }; Returns: undefined };
      finalize_batch: { Args: { p_batch_id: string; p_cash_counts: Json; p_cheque_count: number; p_cheque_total: number }; Returns: undefined };
      unlock_batch: { Args: { p_batch_id: string; p_reason: string }; Returns: undefined };
      save_batch: { Args: { p_church_id: string; p_batch: Json; p_donations: Json; p_deleted_ids?: string[]; p_new_giver_ids?: string[] }; Returns: Json };
      import_legacy_backup: { Args: { p_church_id: string; p_data: Json }; Returns: Json };
      set_smtp_settings: { Args: { p_church_id: string; p_host: string; p_port: number; p_username: string; p_password: string | null; p_from_address: string }; Returns: undefined };
      stage_external_transactions: { Args: { p_church_id: string; p_provider: BatchSourceDb; p_rows: Json }; Returns: Json };
      post_external_batch: { Args: { p_church_id: string; p_provider: BatchSourceDb; p_ids: string[]; p_batch_date?: string | null; p_resolutions?: Json }; Returns: Json };
      set_mailbox_settings: { Args: { p_church_id: string; p_settings: Json; p_secret?: string | null }; Returns: undefined };
      get_mailbox_settings: { Args: { p_church_id: string }; Returns: Json };
      auto_post_external: { Args: { p_church_id: string; p_provider: BatchSourceDb }; Returns: Json };
      get_smtp_settings: { Args: { p_church_id: string }; Returns: { host: string; port: number; username: string; from_address: string; has_password: boolean }[] };
    };
    Enums: {
      member_role: MemberRole;
      batch_status: BatchStatusDb;
      batch_source: BatchSourceDb;
      payment_method: PaymentMethodDb;
    };
    CompositeTypes: { [_ in never]: never };
  };
};
