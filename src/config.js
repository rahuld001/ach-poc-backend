// Runtime mode, originator details and the startup guards that go with them. Imported by index.js before anything
// else, so a misconfigured deployment fails loudly instead of running with defaults.
import 'dotenv/config';

// Falls back to the same public test key the UI uses, so a fresh deploy works before any env vars are set.
export const API_KEY = process.env.API_KEY || 'sk_test_ach_poc_123';
export const isTestMode = API_KEY.startsWith('sk_test_');

const increaseBase = process.env.INCREASE_BASE_URL || 'https://sandbox.increase.com';
export const increaseSandbox = increaseBase.includes('sandbox');

/** Who we are to the ACH network, and how the ODFI wants its files. */
export const ORIGINATOR = {
  odfiRouting: process.env.ODFI_ROUTING || '011000015',
  odfiName: process.env.ODFI_NAME || 'SIMULATED BANK',
  companyName: process.env.COMPANY_NAME || 'ACH POC INC',
  companyId: process.env.COMPANY_ID || '1234567890',
  lineEnding: process.env.ACH_LINE_ENDING === 'CRLF' ? 'CRLF' : 'LF',
  // Balanced files carry an offsetting entry to the company's own account so debits equal credits in each batch.
  balanced: process.env.ACH_BALANCED === 'true',
  companyRouting: process.env.COMPANY_ROUTING_NUMBER || process.env.ODFI_ROUTING || '011000015',
  companyAccount: process.env.COMPANY_ACCOUNT_NUMBER || '',
};

/** How files reach the ODFI: 'mock' (simulated bank in this process) or 'sftp' (real bank drop folder). */
export const ODFI_TRANSPORT = process.env.ODFI_TRANSPORT || 'mock';

/**
 * Bank cut-off times (HH:MM, US Eastern). When set, pending entries are only sent at these times, the way a real ODFI
 * schedules files. Empty = send on every batch interval (the simulated default).
 */
export const CUTOFFS = String(process.env.ACH_CUTOFFS ?? '').split(',').map((s) => s.trim()).filter((s) => /^\d{2}:\d{2}$/.test(s)).sort();

/** Simulation clock for the mock ODFI: how long a banking day and a file acknowledgment take, in seconds. */
export const SIM = {
  bankingDaySeconds: Number(process.env.SIM_BANKING_DAY_SECONDS ?? 20),
  ackSeconds: Number(process.env.SIM_ACK_SECONDS ?? 5),
};

if (!['mock', 'sftp'].includes(ODFI_TRANSPORT)) throw new Error(`ODFI_TRANSPORT must be mock or sftp (got "${ODFI_TRANSPORT}")`);
if (ORIGINATOR.balanced && !ORIGINATOR.companyAccount) {
  throw new Error('ACH_BALANCED=true needs COMPANY_ACCOUNT_NUMBER (the account the offsetting entries post to)');
}

if (!isTestMode) {
  // A live key means real account numbers and real money: no default secrets allowed.
  if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
    throw new Error('ENCRYPTION_KEY must be set (32+ random characters) when API_KEY is a live key');
  }
  if (process.env.ENCRYPTION_KEY === 'change-me-to-a-long-random-string') {
    throw new Error('ENCRYPTION_KEY is still the example value; generate a random one for live mode');
  }
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must be set (32+ random characters) when API_KEY is a live key: it signs user sessions');
  }
} else if (!process.env.ENCRYPTION_KEY) {
  console.warn('[config] ENCRYPTION_KEY is not set; using the development default (test mode only)');
}

// Test mode must never be able to move real money.
if (isTestMode && process.env.INCREASE_API_KEY && !increaseSandbox) {
  throw new Error('Test mode (sk_test_ API key) cannot use the Increase production API; set INCREASE_BASE_URL=https://sandbox.increase.com');
}
