import { Giver } from '../types';

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

export const giversToCSV = (givers: Giver[]): string => {
  const headers = [
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

/** Parse a giver CSV. Rows are matched to existing givers by envelope number on import. */
export const parseGiversCSV = (csvContent: string): Giver[] => {
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
    
    newGivers.push(giver);
  }
  
  return newGivers;
};
