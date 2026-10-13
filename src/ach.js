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
  R05: 'Unauthorized Debit to Consumer Account Using Corporate SEC Code',
  R06: 'Returned per ODFI Request',
  R07: 'Authorization Revoked by Customer',
  R08: 'Payment Stopped',
  R09: 'Uncollected Funds',
  R10: 'Customer Advises Not Authorized',
  R11: 'Customer Advises Entry Not in Accordance with the Terms of the Authorization',
  R12: 'Account Sold to Another DFI',
  R16: 'Account Frozen',
  R20: 'Non-Transaction Account',
  R24: 'Duplicate Entry',
  R29: 'Corporate Customer Advises Not Authorized',
};

// Return codes after which the account must not be used again without new authorization / new account data.
export const DISABLING_RETURN_CODES = new Set(['R02', 'R03', 'R04', 'R05', 'R07', 'R10', 'R11', 'R12', 'R16', 'R20', 'R29']);

// Nacha return-rate thresholds for originators, measured over the preceding 60 days of debit entries.
export const RETURN_RATE_THRESHOLDS = { unauthorized: 0.005, administrative: 0.03, overall: 0.15 };
export const UNAUTHORIZED_RETURN_CODES = ['R05', 'R07', 'R10', 'R11', 'R29', 'R51'];
export const ADMINISTRATIVE_RETURN_CODES = ['R02', 'R03', 'R04'];

// Notifications of change: the RDFI accepted the entry but tells us to fix the account data within 6 banking days.
export const NOC_CODES = {
  C01: 'Incorrect account number',
  C02: 'Incorrect routing number',
  C03: 'Incorrect routing number and account number',
  C05: 'Incorrect transaction code (account type)',
  C06: 'Incorrect account number and transaction code',
  C07: 'Incorrect routing number, account number and transaction code',
};

// Simulated receiving banks: accounts ending in these digits are returned with the given code...
export const TEST_ACCOUNT_OUTCOMES = {
  '0001': 'R01',
  '0002': 'R02',
  '0003': 'R03',
  '0004': 'R04',
  '0010': 'R10',
};
// ...or settle and come back with a notification of change.
export const TEST_NOC_OUTCOMES = {
  '0005': 'C01',
  '0006': 'C02',
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

/** Company entry description (10 chars) shown on the receiver's bank statement. */
export function entryDescriptionFor({ purpose, direction }) {
  if (purpose === 'micro_deposit') return 'ACCTVERIFY';
  if (purpose === 'reversal') return 'REVERSAL';
  return direction === 'debit' ? 'PAYMENT' : 'PAYOUT';
}

// --- Banking days -------------------------------------------------------------------------------------------------

const nthWeekday = (year, month, weekday, n) => {
  const first = new Date(year, month, 1);
  return new Date(year, month, 1 + ((weekday - first.getDay() + 7) % 7) + (n - 1) * 7);
};
const lastWeekday = (year, month, weekday) => {
  const last = new Date(year, month + 1, 0);
  return new Date(year, month + 1, 0 - ((last.getDay() - weekday + 7) % 7));
};
// Fixed-date holidays that fall on a Sunday are observed on the Monday; on a Saturday the Fed stays open Friday.
const fixed = (year, month, day) => {
  const d = new Date(year, month, day);
  if (d.getDay() === 0) d.setDate(day + 1);
  return d;
};

/** Federal Reserve Bank holidays, when the ACH network does not settle. */
export function federalReserveHolidays(year) {
  return [
    fixed(year, 0, 1), // New Year's Day
    nthWeekday(year, 0, 1, 3), // Martin Luther King Jr. Day
    nthWeekday(year, 1, 1, 3), // Presidents' Day
    lastWeekday(year, 4, 1), // Memorial Day
    fixed(year, 5, 19), // Juneteenth
    fixed(year, 6, 4), // Independence Day
    nthWeekday(year, 8, 1, 1), // Labor Day
    nthWeekday(year, 9, 1, 2), // Columbus Day
    fixed(year, 10, 11), // Veterans Day
    nthWeekday(year, 10, 4, 4), // Thanksgiving
    fixed(year, 11, 25), // Christmas
  ];
}

export function isBankingDay(d) {
  if (d.getDay() === 0 || d.getDay() === 6) return false;
  const iso = toIsoDate(d);
  return !federalReserveHolidays(d.getFullYear()).some((h) => toIsoDate(h) === iso);
}

/** The date n banking days after `from` (weekends and Federal Reserve holidays skipped). */
export function addBankingDays(from, n) {
  const d = new Date(from);
  let left = n;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (isBankingDay(d)) left--;
  }
  return d;
}

/** Next day the ACH network settles. */
export function nextBusinessDay(from = new Date()) {
  return addBankingDays(from, 1);
}

export function toIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' -> local Date (the pg driver returns DATE columns as strings). */
export function parseIsoDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Nacha timing rules used for the return window and reversals.
export const RETURN_WINDOW_BANKING_DAYS = 2; // R01-type returns: 2 banking days after settlement
export const UNAUTHORIZED_RETURN_WINDOW_DAYS = 60; // consumer unauthorized returns (R05/R07/R10/R11/R29)
export const REVERSAL_WINDOW_BANKING_DAYS = 5; // a reversing entry must be sent within 5 banking days of settlement

// --- Customer authorization ---------------------------------------------------------------------------------------

// The server owns the wording of the authorization the customer accepts, so a client cannot record a mandate the
// customer never saw. The UI renders the same templates (via /api/config) with {amount} and {last4} filled in.
const COMPANY = process.env.COMPANY_NAME || 'ACH POC Inc.';
export const AUTHORIZATION_TEMPLATES = {
  debit:
    `I authorize ${COMPANY} to electronically debit my bank account ending in {last4} for {amount}, ` +
    'and, if necessary, to electronically credit my account to correct erroneous debits. ' +
    'I understand this authorization remains in effect until the payment is processed or I cancel it before submission.',
  credit:
    `I authorize ${COMPANY} to electronically credit {amount} to my bank account ending in {last4}, ` +
    'and, if necessary, to debit my account to correct any erroneous credit.',
  verification:
    `I authorize ${COMPANY} to verify my bank account ending in {last4} by sending two small credits ` +
    '(each under $1.00) and then debiting the same total amount from the account.',
};

export const formatUsd = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function authorizationText(kind, amountCents, last4) {
  return AUTHORIZATION_TEMPLATES[kind].replaceAll('{amount}', formatUsd(amountCents ?? 0)).replaceAll('{last4}', last4);
}
