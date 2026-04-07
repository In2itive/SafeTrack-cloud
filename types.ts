export enum UserRole {
  Administrator = 'Administrator',
  Treasurer = 'Treasurer',
  Envelope = 'Envelope',
  Teller = 'Teller'
}

export interface User {
  id?: number;
  username: string;
  name: string;
  role: UserRole;
  email: string;
  passwordHash?: string; // Simple hash for local auth
}

export interface FundEntity {
  id?: number;
  name: string;
  isSystem: boolean; // Cannot be deleted/renamed if true
  isActive: boolean;
}

export interface InternalAccount {
  id?: number;
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
  id?: number;
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
}

export interface DonationSplit {
  fund: string;
  amount: number;
  internalAccount?: string;
}

export interface Donation {
  id?: number;
  giverId: number;
  batchId: number;
  amount: number; // Total amount of donation
  date: string;
  paymentMethod: PaymentMethod;
  splits: DonationSplit[];
  chequeNumber?: string;
  notes?: string;
  cashCounts?: Record<string, number>; // Persisted breakdown of cash denominations
}

export interface Batch {
  id?: number;
  batchNumber: string;
  date: string;
  status: BatchStatus;
  source: BatchSource;
  totalAmount: number;
  itemCount: number;
  newGiverIds?: number[]; // Track givers created during this batch
  finalizedBy?: string[]; // Names of tellers who finalized the batch
}

export interface AppSettings {
  id?: number;
  nextEnvelopeNumber: number;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  smtpFrom?: string;
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