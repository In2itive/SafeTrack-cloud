import Dexie, { type Table } from 'dexie';
import { Giver, Batch, Donation, AppSettings, BatchSource, FundEntity, User, InternalAccount } from '../types';

class ChurchDatabase extends Dexie {
  givers!: Table<Giver, number>;
  batches!: Table<Batch, number>;
  donations!: Table<Donation, number>;
  settings!: Table<AppSettings, number>;
  funds!: Table<FundEntity, number>;
  users!: Table<User, number>;
  internalAccounts!: Table<InternalAccount, number>;

  constructor() {
    super('SafeTrackDB');
    // Cast 'this' to any to avoid TS error: Property 'version' does not exist on type 'ChurchDatabase'
    (this as any).version(1).stores({
      givers: '++id, envelopeNumber, name, eTransferId, pushPayId',
      batches: '++id, batchNumber, date, status',
      donations: '++id, giverId, batchId, date',
      settings: '++id'
    });

    // Version 2: Add eTransferId2 to index
    (this as any).version(2).stores({
      givers: '++id, envelopeNumber, name, eTransferId, eTransferId2, pushPayId'
    });

    // Version 3: Add source to batches and migrate existing
    (this as any).version(3).stores({
      batches: '++id, batchNumber, date, status, source'
    }).upgrade((trans: any) => {
      return trans.table("batches").toCollection().modify((batch: Batch) => {
        if (!batch.source) {
          batch.source = BatchSource.InPerson;
        }
      });
    });

    // Version 4: Add configurable funds
    (this as any).version(4).stores({
      funds: '++id, name, isActive'
    });

    // Version 5: Add users table
    (this as any).version(5).stores({
      users: '++id, username, email, role'
    });

    // Version 6: Add internalAccounts table
    (this as any).version(6).stores({
      internalAccounts: '++id, name, isActive'
    });
  }
}

export const db = new ChurchDatabase();

// Initial Setup Helper
export const initDatabase = async () => {
  const settingsCount = await db.settings.count();
  if (settingsCount === 0) {
    await db.settings.add({ nextEnvelopeNumber: 100 });
  }

  const fundsCount = await db.funds.count();
  if (fundsCount === 0) {
    const defaultFunds = [
      'General',
      'Benevolent',
      'Missions',
      'Building',
      'Capital',
      'Interns',
      'Internal'
    ];
    
    await db.funds.bulkAdd(defaultFunds.map(name => ({
      name,
      isSystem: true,
      isActive: true
    })));
  }
};

export const getNextEnvelopeNumber = async (): Promise<number> => {
  const setting = await db.settings.orderBy('id').first();
  return setting?.nextEnvelopeNumber || 100;
};

export const incrementEnvelopeNumber = async () => {
  const setting = await db.settings.orderBy('id').first();
  if (setting && setting.id) {
    await db.settings.update(setting.id, { nextEnvelopeNumber: setting.nextEnvelopeNumber + 1 });
  }
};

export const exportData = async (): Promise<string> => {
  const allGivers = await db.givers.toArray();
  const allBatches = await db.batches.toArray();
  const allDonations = await db.donations.toArray();
  const allSettings = await db.settings.toArray();
  const allFunds = await db.funds.toArray();
  const allInternalAccounts = await db.internalAccounts.toArray();
  
  return JSON.stringify({ 
    givers: allGivers, 
    batches: allBatches, 
    donations: allDonations, 
    settings: allSettings,
    funds: allFunds,
    internalAccounts: allInternalAccounts
  });
};

export const importData = async (jsonString: string) => {
  const data = JSON.parse(jsonString);
  // Cast 'db' to any to avoid TS error: Property 'transaction' does not exist on type 'ChurchDatabase'
  await (db as any).transaction('rw', db.givers, db.batches, db.donations, db.settings, db.funds, db.internalAccounts, async () => {
    await db.givers.clear();
    await db.batches.clear();
    await db.donations.clear();
    await db.settings.clear();
    await db.funds.clear();
    await db.internalAccounts.clear();

    if(data.givers) await db.givers.bulkAdd(data.givers);
    if(data.batches) await db.batches.bulkAdd(data.batches);
    if(data.donations) await db.donations.bulkAdd(data.donations);
    if(data.settings) await db.settings.bulkAdd(data.settings);
    if(data.funds) await db.funds.bulkAdd(data.funds);
    if(data.internalAccounts) await db.internalAccounts.bulkAdd(data.internalAccounts);
  });
};

// CSV Helpers
const escapeCSV = (str: string | undefined | number): string => {
  if (str === undefined || str === null) return '';
  const stringValue = String(str);
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
};

const parseCSVLine = (line: string): string[] => {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
  }
  result.push(current);
  return result;
};

export const exportGiversCSV = async (): Promise<string> => {
  const givers = await db.givers.toArray();
  const headers = [
    'System ID', 
    'Envelope Number', 
    'Name', 
    'Joint Name', 
    'Email', 
    'Secondary Email', 
    'Address 1', 
    'Address 2', 
    'Address 3', 
    'E-Transfer ID', 
    'Secondary E-Transfer ID', 
    'PushPay ID'
  ];
  
  const rows = givers.map(g => [
    g.id,
    g.envelopeNumber,
    g.name,
    g.name2,
    g.email,
    g.email2,
    g.address1,
    g.address2,
    g.address3,
    g.eTransferId,
    g.eTransferId2,
    g.pushPayId
  ].map(escapeCSV).join(','));
  
  return [headers.join(','), ...rows].join('\n');
};

export const importGiversCSV = async (csvContent: string) => {
  // Handle all line endings: Windows (\r\n), Unix (\n), and old Mac (\r)
  const lines = csvContent.split(/\r\n|\n|\r/).filter(line => line.trim().length > 0);
  if (lines.length < 2) throw new Error("Invalid CSV: No data found");
  
  // Handle BOM and parse headers
  let headerLine = lines[0];
  if (headerLine.charCodeAt(0) === 0xFEFF) {
    headerLine = headerLine.slice(1);
  }
  
  const headers = parseCSVLine(headerLine).map(h => h.trim().toLowerCase());
  
  // Flexible header matching
  const findHeaderIndex = (variations: string[]) => {
    for (const v of variations) {
      const idx = headers.indexOf(v);
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const envIdx = findHeaderIndex(['envelope number', 'envelope #', 'envelope', 'env #', 'env']);
  const nameIdx = findHeaderIndex(['name', 'giver name', 'giver']);
  
  if (envIdx === -1) throw new Error(`Invalid CSV: Missing required column 'Envelope Number' (found: ${headers.join(', ')})`);
  if (nameIdx === -1) throw new Error(`Invalid CSV: Missing required column 'Name' (found: ${headers.join(', ')})`);
  
  const headerMap = new Map<string, number>();
  headers.forEach((h, i) => headerMap.set(h, i));
  
  const newGivers: Giver[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    
    // Helper to get value by flexible header name
    const getVal = (variations: string[]) => {
      const idx = findHeaderIndex(variations);
      const val = idx !== undefined ? values[idx] : undefined;
      return val ? val.trim() : undefined;
    };
    
    // Direct access for required fields using known indices
    const envelopeStr = values[envIdx]?.trim();
    const name = values[nameIdx]?.trim();
    
    if (!envelopeStr || !name) continue; // Skip invalid rows
    
    const giver: Giver = {
      envelopeNumber: parseInt(envelopeStr),
      name: name,
      name2: getVal(['joint name', 'spouse', 'secondary name']) || undefined,
      email: getVal(['email', 'email address', 'primary email']) || undefined,
      email2: getVal(['secondary email', 'email 2', 'spouse email']) || undefined,
      address1: getVal(['address 1', 'address', 'street']) || undefined,
      address2: getVal(['address 2', 'unit', 'apt']) || undefined,
      address3: getVal(['address 3', 'city/state/zip', 'city', 'state', 'zip']) || undefined,
      eTransferId: getVal(['e-transfer id', 'etransfer id', 'phone', 'phone 1']) || undefined,
      eTransferId2: getVal(['secondary e-transfer id', 'etransfer id 2', 'phone 2']) || undefined,
      pushPayId: getVal(['pushpay id', 'pushpay']) || undefined,
    };
    
    const idStr = getVal(['system id', 'id']);
    if (idStr && !isNaN(parseInt(idStr))) {
      giver.id = parseInt(idStr);
    }
    
    newGivers.push(giver);
  }
  
  await db.transaction('rw', db.givers, async () => {
    await db.givers.clear();
    await db.givers.bulkAdd(newGivers);
  });
  
  return newGivers.length;
};