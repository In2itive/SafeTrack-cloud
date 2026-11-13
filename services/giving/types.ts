/**
 * Online giving: the provider-agnostic contract.
 *
 * Every giving platform (Pushpay today, our own Stripe module later) is an
 * adapter that produces GiftRecords. Everything after that — staging,
 * dedupe, giver/fund matching, posting to a batch, two-person sign-off — is
 * shared and knows nothing about the provider.
 *
 *   FileProvider      the church downloads a table (Pushpay CSV) and uploads it
 *   DocumentProvider  the church uploads/pastes documents, one gift each
 *                     (Interac e-Transfer notification emails)
 *   FeedProvider  gifts arrive server-side (a Stripe webhook writes them with
 *                 stage_external_transactions_server); the app only reviews
 *
 * See docs/GIVING_PROVIDERS.md.
 */

/** Matches the database batch_source enum (minus in_person). */
export type ProviderId = 'pushpay' | 'stripe' | 'e_transfer';

/** Electronic payment methods (database payment_method values). */
export type ElectronicMethod = 'card' | 'bank_debit' | 'online' | 'e_transfer';

export type GiftStatus = 'succeeded' | 'pending' | 'failed' | 'refunded';

/** One gift, normalised. Field names mirror external_transactions. */
export interface GiftRecord {
  externalId: string;
  giftDate: string;          // YYYY-MM-DD
  amount: number;            // gross, > 0
  fee: number;               // processing fee, >= 0
  currency?: string;
  method: ElectronicMethod;
  status: GiftStatus;
  payerExternalId?: string;
  payerEnvelope?: number;    // church envelope number, when the provider exports it
  payerFirstName?: string;
  payerLastName?: string;
  payerName?: string;
  payerEmail?: string;
  payerPhone?: string;
  payerAddress?: string;
  fundKey?: string;          // provider's fund code, or its name
  fundName?: string;
  memo?: string;
  depositRef?: string;       // provider batch / deposit / payout
  /** Memo exactly as the provider sent it (before tidying). */
  memoRaw?: string;
  /** Review flags (FLAG_TEXT keys). Flagged gifts are never posted automatically. */
  flags?: string[];
  raw: Record<string, string>;
}

export interface SkippedRow { line: number; reason: string; summary: string }

export interface ParseResult {
  gifts: GiftRecord[];
  skipped: SkippedRow[];
  warnings: string[];
}

/** A logical field a file column can map to. */
export interface FieldDef {
  key: string;
  label: string;
  required?: boolean;
  /** Lower-case header names that map to this field automatically. */
  aliases: string[];
  hint?: string;
}

/** field key -> column index in the file (absent = not mapped) */
export type ColumnMapping = Record<string, number | undefined>;

export type DateOrder = 'auto' | 'mdy' | 'dmy' | 'ymd';

export interface ParseOptions { dateOrder: DateOrder }

export interface CsvTable { headers: string[]; rows: string[][]; firstDataLine: number }

interface ProviderBase {
  id: ProviderId;
  label: string;
  description: string;
  /** How the review screen groups gifts into batches by default. */
  defaultGrouping?: 'deposit' | 'date' | 'week';
  /** Text for the reconciliation panel: what the second person checks against. */
  reconcileAgainst?: string;
}

export interface FileProvider extends ProviderBase {
  kind: 'file';
  accept: string;
  /** Short how-to-export steps shown above the upload box. */
  exportSteps: string[];
  fields: FieldDef[];
  detectMapping(headers: string[]): ColumnMapping;
  /** Fields that must be mapped before parse() can run. */
  missingFields(mapping: ColumnMapping): FieldDef[];
  parse(table: CsvTable, mapping: ColumnMapping, options: ParseOptions): ParseResult;
}

/** One uploaded file, or one paste. */
export interface SourceDoc { name: string; content: string | ArrayBuffer; lastModified?: number }

export interface DocumentProvider extends ProviderBase {
  kind: 'documents';
  accept: string;
  exportSteps: string[];
  /** Placeholder for the paste box. */
  pasteHint: string;
  parseDocuments(docs: SourceDoc[]): Promise<ParseResult>;
}

export interface FeedProvider extends ProviderBase {
  kind: 'feed';
}

export type GivingProvider = FileProvider | DocumentProvider | FeedProvider;

/** A staged gift as stored in external_transactions. */
export interface StagedGift extends GiftRecord {
  id: string;
  giverId?: string;
  fundId?: string;
  ignored: boolean;
  donationId?: string;
  stagedAt: string;
  /** Problems found in the email/file itself (stored once). */
  reviewFlags: string[];
  /** Problems matching it to a giver/fund (recomputed by the automatic matcher). */
  matchFlags: string[];
  inboundMessageId?: string;
}

export interface MailboxSettingsView {
  kind: 'imap' | 'graph';
  enabled: boolean;
  auto_post: boolean;
  time_zone: string;
  since_date: string;
  sender_filter: string | null;
  imap_host: string | null; imap_port: number | null; imap_tls: boolean; imap_username: string | null; imap_folder: string;
  graph_tenant_id: string | null; graph_client_id: string | null; graph_mailbox: string | null; graph_folder: string;
  has_secret: boolean;
  last_polled_at: string | null; last_success_at: string | null; last_error: string | null;
  last_result: Record<string, unknown> | null;
}

export interface InboxMessage {
  id: string; source: string; receivedAt?: string; from?: string; subject?: string;
  status: 'staged' | 'duplicate' | 'skipped' | 'error'; reason?: string; externalTransactionId?: string; createdAt: string;
}

export interface StageResult { inserted: number; updated: number; already_posted: number; refunded_after_post: number }
export interface PostResult { batch_id: string; batch_number: string; count: number; total: number; fees: number }
