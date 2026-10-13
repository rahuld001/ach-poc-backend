import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAchFile, maskAccountNumbers, parseAchFile } from '../src/nacha.js';
import { isValidRoutingNumber, transactionCode } from '../src/ach.js';

const base = {
  odfiRouting: '011000015',
  odfiName: 'SIMULATED BANK',
  companyName: 'ACH POC INC',
  companyId: '1234567890',
  fileIdModifier: 'A',
  now: new Date(2026, 9, 12, 9, 30),
};

const entry = (overrides) => ({
  transactionCode: '27',
  routing: '011401533',
  account: '1111222233330000',
  amountCents: 5000,
  individualId: 'CUST1',
  individualName: 'Jane Doe',
  traceNumber: '011000010000001',
  ...overrides,
});

test('routing number checksum', () => {
  assert.ok(isValidRoutingNumber('011401533'));
  assert.ok(isValidRoutingNumber('021000021'));
  assert.ok(!isValidRoutingNumber('011401534'));
  assert.ok(!isValidRoutingNumber('12345'));
});

test('transaction codes', () => {
  assert.equal(transactionCode('debit', 'checking'), '27');
  assert.equal(transactionCode('debit', 'savings'), '37');
  assert.equal(transactionCode('credit', 'checking'), '22');
  assert.equal(transactionCode('credit', 'savings'), '32');
});

test('builds a valid, balanced NACHA file', () => {
  const file = buildAchFile({
    ...base,
    batches: [
      {
        secCode: 'WEB',
        entryDescription: 'PAYMENT',
        paymentTypeCode: 'S',
        effectiveDate: new Date(2026, 9, 13),
        entries: [entry(), entry({ amountCents: 1234, traceNumber: '011000010000002', routing: '021000021' })],
      },
      {
        secCode: 'PPD',
        entryDescription: 'PAYOUT',
        effectiveDate: new Date(2026, 9, 13),
        entries: [entry({ transactionCode: '22', amountCents: 999, traceNumber: '011000010000003' })],
      },
    ],
  });

  const lines = file.content.trimEnd().split('\n');
  assert.equal(lines.length % 10, 0);
  for (const l of lines) assert.equal(l.length, 94);

  // record types in order, P = all-9 padding record
  assert.equal(lines.map((l) => (/^9+$/.test(l) ? 'P' : l[0])).join(''), '156685689P');
  assert.equal(lines[0].slice(23, 29), '261012'); // creation date
  assert.equal(lines[1].slice(1, 4), '225'); // debit-only batch
  assert.equal(lines[1].slice(50, 53), 'WEB');
  assert.equal(lines[2].slice(76, 78), 'S '); // WEB payment type code: single entry
  assert.equal(lines[5].slice(1, 4), '220'); // credit-only batch
  assert.equal(lines[6].slice(76, 78), '  '); // PPD: discretionary data blank

  assert.equal(file.entryCount, 3);
  assert.equal(file.totalDebitCents, 6234);
  assert.equal(file.totalCreditCents, 999);
  assert.equal(file.entryHash, 1140153 + 2100002 + 1140153);

  const parsed = parseAchFile(file.content);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.entries.length, 3);
  assert.equal(parsed.entries[0].account, '1111222233330000');
  assert.equal(parsed.entries[0].traceNumber, '011000010000001');
  assert.equal(parsed.entries[1].amountCents, 1234);
  assert.equal(parsed.entries[0].paymentTypeCode, 'S');
  assert.equal(parsed.entries[2].paymentTypeCode, '');
});

test('WEB entries must carry a payment type code', () => {
  assert.throws(
    () => buildAchFile({ ...base, batches: [{ secCode: 'WEB', entryDescription: 'PAYMENT', effectiveDate: new Date(), entries: [entry()] }] }),
    /Payment Type Code/,
  );
  // Per-entry code also accepted, and 'R' for recurring.
  const file = buildAchFile({
    ...base,
    batches: [{ secCode: 'WEB', entryDescription: 'PAYMENT', effectiveDate: new Date(), entries: [entry({ paymentTypeCode: 'R' })] }],
  });
  assert.equal(file.content.split('\n')[2].slice(76, 78), 'R ');
});

test('masking hides everything but the last 4 digits of each account number', () => {
  const file = buildAchFile({
    ...base,
    batches: [{ secCode: 'PPD', entryDescription: 'PAYOUT', effectiveDate: new Date(), entries: [entry({ transactionCode: '22' })] }],
  });
  const masked = maskAccountNumbers(file.content);
  const lines = masked.trimEnd().split('\n');
  assert.equal(lines[2].slice(12, 29), '************0000 ');
  assert.ok(!masked.includes('1111222233330000'));
  assert.equal(lines[2].length, 94);
  assert.equal(lines[2].slice(29), file.content.split('\n')[2].slice(29), 'rest of the record unchanged');
  assert.equal(parseAchFile(masked).entries[0].amountCents, 5000, 'masked file still parses');
});

test('parser rejects a tampered file', () => {
  const file = buildAchFile({
    ...base,
    batches: [{ secCode: 'WEB', entryDescription: 'PAYMENT', paymentTypeCode: 'S', effectiveDate: new Date(2026, 9, 13), entries: [entry()] }],
  });
  const tampered = file.content.replace('0000005000', '0000009000');
  assert.ok(parseAchFile(tampered).errors.includes('File control total debit mismatch'));
});

test('rejects values that overflow numeric fields', () => {
  assert.throws(() =>
    buildAchFile({
      ...base,
      batches: [{ secCode: 'WEB', entryDescription: 'X', paymentTypeCode: 'S', effectiveDate: new Date(), entries: [entry({ amountCents: 1e11 })] }],
    }),
  );
});
