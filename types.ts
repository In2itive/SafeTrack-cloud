export enum UserRole {
  Administrator = 'Administrator',
  Treasurer = 'Treasurer',
  Envelope = 'Envelope',
  Teller = 'Teller'
}

export interface User {
  id?: string;        // Supabase auth user id
  name: string;       // display name within the church
  role: UserRole;
  email: string;
  isActive?: boolean;
}

export interface FundEntity {
  id?: string;
  name: string;
  isSystem: boolean; // Cannot be deleted/renamed if true
  isActive: boolean;
}

export interface InternalAccount {
  id?: string;
  name: string;
  isActive: boolean;
}

export enum PaymentMethod {
  Cash = 'Cash',
  Cheque = 'Cheque',
  ETransfer = 'E-Transfer'
}

export enum BatchStatus {
  Open = 'Open',
  Finalized = 'Finalized'
}

export enum BatchSource {
  InPerson = 'In-Person',
  ETransfer = 'E-Transfer',
  PushPay = 'PushPay'
}

export interface Giver {
  id?: string;
  envelopeNumber: number;
  
  // Identity
  name: string; // Primary Name
  name2?: string; // Joint/Spouse Name
  
  // Contact
  email?: string;
  email2?: string; // Secondary Email
  address1?: string;
  address2?: string;
  address3?: string;
  
  // Digital IDs
  eTransferId?: string; // Primary E-Transfer ID (Phone/Email)
  eTransferId2?: string; // Secondary E-Transfer ID
  pushPayId?: string;
  isSystem?: boolean; // #0 Loose Giving, #1 Internal
}

export interface DonationSplit {
  fund: string;
  amount: number;
  internalAccount?: string;
}

export interface Donation {
  id?: string;
  transactionNumber?: string; // YYYY####NNNNNN, assigned by the server
  giverId: string;
  batchId: string;
  amount: number; // Total amount of donation
  date: string;
  paymentMethod: PaymentMethod;
  splits: DonationSplit[];
  chequeNumber?: string;
  notes?: string;
  cashCounts?: Record<string, number>; // Persisted breakdown of cash denominations
}

export interface Batch {
  id?: string;
  batchNumber: string;
  date: string;
  status: BatchStatus;
  source: BatchSource;
  totalAmount: number;
  itemCount: number;
  newGiverIds?: string[]; // Givers created during this batch
  finalizedBy?: string[]; // Names of the tellers who signed the original count
  adjustedBy?: string[];  // Names of admins who signed later adjustments
  revision?: number;
}

export interface SignOff {
  revision: number;
  name: string;
  role: UserRole;
  signedAt: string;
}

export interface AppSettings {
  nextEnvelopeNumber: number;
  allowAdminSoloFinalize?: boolean;
  accountingRecipients?: string;
  envelopeRecipients?: string;
  depositRecipients?: string;
  bankLogo?: string;
  accountOf?: string;
  branchNumber?: string;
  accountNumber?: string;
  churchLogo?: string;
  churchAddressLine1?: string;
  churchAddressLine2?: string;
  churchAddressLine3?: string;
}
// SMTP settings never travel to the browser with the password.
export interface SmtpSettings {
  host: string;
  port: number;
  username: string;
  fromAddress: string;
  hasPassword: boolean;
}
