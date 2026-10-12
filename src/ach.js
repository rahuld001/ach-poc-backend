// ACH reference data and helpers.

// ABA routing number checksum: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) must be divisible by 10.
export function isValidRoutingNumber(routing) {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = routing.split('').map(Number);
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

export const RETURN_CODES = {
  R01: 'Insufficient Funds',
  R02: 'Account Closed',
  R03: 'No Account/Unable to Locate Account',
  R04: 'Invalid Account Number Structure',
  R07: 'Authorization Revoked by Customer',
  R08: 'Payment Stopped',
  R10: 'Customer Advises Not Authorized',
  R16: 'Account Frozen',
  R29: 'Corporate Customer Advises Not Authorized',
};

// Return codes after which the account must not be used again.
export const DISABLING_RETURN_CODES = new Set(['R02', 'R03', 'R04', 'R07', 'R10', 'R16', 'R29']);

// Mock bank behaviour: accounts ending in these digits are returned with the given code.
export const TEST_ACCOUNT_OUTCOMES = {
  '0001': 'R01',
  '0002': 'R02',
  '0003': 'R03',
  '0010': 'R10',
};

// Transaction codes for entry detail records.
export function transactionCode(direction, accountType) {
  if (direction === 'credit') return accountType === 'savings' ? '32' : '22';
  return accountType === 'savings' ? '37' : '27';
}

// WEB = consumer authorized online (debits), PPD = prearranged consumer payment (payouts).
export function secCodeFor(direction) {
  return direction === 'debit' ? 'WEB' : 'PPD';
}

export function nextBusinessDay(from = new Date()) {
  const d = new Date(from);
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return d;
}

export function toIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
