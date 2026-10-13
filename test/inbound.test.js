import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAchFile, parseAchFile, RETURN_CODES_BY_ORIGINAL } from '../src/nacha.js';

const base = {
  odfiRouting: '011000015',
  odfiName: 'SIMULATED BANK',
  companyName: 'ACH POC INC',
  companyId: '1234567890',
  fileIdModifier: 'R',
  now: new Date(2026, 9, 14, 8, 0),
};

test('return file: addenda 99 carries the reason code and original trace, totals include addenda', () => {
  const file = buildAchFile({
    ...base,
    immediateOrigin: ' 011000015',
    destinationName: 'ACH POC INC',
    originName: 'SIMULATED BANK',
    batches: [
      {
        secCode: 'WEB',
        entryDescription: 'PAYMENT',
        effectiveDate: new Date(2026, 9, 14),
        entries: [
          {
            transactionCode: RETURN_CODES_BY_ORIGINAL['27'], // returned checking debit -> 26
            routing: '021000021',
            account: '5550001',
            amountCents: 2500,
            individualId: 'ABC',
            individualName: 'Broke Bob',
            paymentTypeCode: 'S',
            traceNumber: '021000020000001',
            addenda: { typeCode: '99', returnReasonCode: 'R01', originalTraceNumber: '011000010000042', originalRdfi: '02100002' },
          },
        ],
      },
    ],
  });
  const lines = file.content.trimEnd().split('\n');
  assert.equal(lines.map((l) => (/^9+$/.test(l) ? 'P' : l[0])).join(''), '156789PPPP');
  assert.equal(lines[2][78], '1', 'addenda record indicator');
  assert.equal(lines[3].slice(0, 6), '799R01');
  assert.equal(lines[3].slice(6, 21), '011000010000042');
  assert.equal(lines[3].slice(79, 94), '021000020000001');
  assert.equal(file.entryCount, 2, 'entry + addenda');
  assert.equal(file.totalDebitCents, 2500, 'a returned debit (26) counts on the debit side');

  const parsed = parseAchFile(file.content);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.header.fileIdModifier, 'R');
  assert.equal(parsed.header.immediateOrigin, '011000015');
  assert.equal(parsed.batches.length, 1);
  assert.equal(parsed.entries[0].secCode, 'WEB');
  assert.equal(parsed.entries[0].transactionCode, '26');
  assert.deepEqual(
    { ...parsed.entries[0].addenda, addendaInfo: undefined, dateOfDeath: undefined },
    { typeCode: '99', returnReasonCode: 'R01', originalTraceNumber: '011000010000042', originalRdfi: '02100002', traceNumber: '021000020000001', addendaInfo: undefined, dateOfDeath: undefined },
  );
});

test('NOC file: COR batch with addenda 98 and the corrected account number', () => {
  const file = buildAchFile({
    ...base,
    batches: [
      {
        secCode: 'COR',
        entryDescription: 'NOC',
        serviceClass: '200',
        effectiveDate: new Date(2026, 9, 14),
        entries: [
          {
            transactionCode: '21',
            routing: '011401533',
            account: '5550005',
            amountCents: 0,
            individualId: 'X',
            individualName: 'Jane Doe',
            traceNumber: '011401530000007',
            addenda: { typeCode: '98', changeCode: 'C01', originalTraceNumber: '011000010000043', originalRdfi: '01140153', correctedData: '5559005'.padEnd(17, ' ') },
          },
        ],
      },
    ],
  });
  const parsed = parseAchFile(file.content);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.batches[0].secCode, 'COR');
  assert.equal(parsed.batches[0].serviceClass, '200');
  assert.equal(parsed.entries[0].amountCents, 0);
  assert.equal(parsed.entries[0].addenda.typeCode, '98');
  assert.equal(parsed.entries[0].addenda.changeCode, 'C01');
  assert.equal(parsed.entries[0].addenda.correctedData, '5559005');
  assert.equal(parsed.entries[0].addenda.originalTraceNumber, '011000010000043');
});

test('CRLF line endings are produced on request and parsed back', () => {
  const file = buildAchFile({
    ...base,
    lineEnding: 'CRLF',
    batches: [{ secCode: 'PPD', entryDescription: 'PAYOUT', effectiveDate: new Date(2026, 9, 14), entries: [
      { transactionCode: '22', routing: '011401533', account: '123', amountCents: 100, individualId: 'A', individualName: 'B', traceNumber: '011000010000001' },
    ] }],
  });
  assert.ok(file.content.includes('\r\n'));
  assert.deepEqual(parseAchFile(file.content).errors, []);
});

test('a tampered entry/addenda count is detected', () => {
  const file = buildAchFile({
    ...base,
    batches: [{ secCode: 'PPD', entryDescription: 'PAYOUT', effectiveDate: new Date(2026, 9, 14), entries: [
      { transactionCode: '22', routing: '011401533', account: '123', amountCents: 100, individualId: 'A', individualName: 'B', traceNumber: '011000010000001' },
    ] }],
  });
  const lines = file.content.trimEnd().split('\n');
  const control = lines.findIndex((l) => l[0] === '9' && !/^9+$/.test(l));
  lines[control] = lines[control].slice(0, 13) + '00000002' + lines[control].slice(21);
  assert.ok(parseAchFile(lines.join('\n') + '\n').errors.includes('File control entry/addenda count mismatch'));
});
