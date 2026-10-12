// NACHA file builder / parser. Every record is exactly 94 characters; the file is
// padded with all-9 records to a multiple of 10 lines (blocking factor 10).

const RECORD_LENGTH = 94;
const BLOCKING_FACTOR = 10;

function alpha(value, length) {
  const clean = String(value ?? '')
    .toUpperCase()
    .replace(/[^\x20-\x7E]/g, '');
  return clean.slice(0, length).padEnd(length, ' ');
}

function num(value, length) {
  const s = String(value);
  if (!/^\d+$/.test(s) || s.length > length) {
    throw new Error(`Value "${s}" does not fit numeric field of length ${length}`);
  }
  return s.padStart(length, '0');
}

const pad2 = (n) => String(n).padStart(2, '0');

function yymmdd(d) {
  return pad2(d.getFullYear() % 100) + pad2(d.getMonth() + 1) + pad2(d.getDate());
}

function hhmm(d) {
  return pad2(d.getHours()) + pad2(d.getMinutes());
}

function record(...fields) {
  const line = fields.join('');
  if (line.length !== RECORD_LENGTH) {
    throw new Error(`NACHA record must be ${RECORD_LENGTH} chars, got ${line.length}: ${line}`);
  }
  return line;
}

/**
 * @param {object} opts
 * @param {string} opts.odfiRouting      9-digit routing of the originating bank
 * @param {string} opts.odfiName
 * @param {string} opts.companyName
 * @param {string} opts.companyId        10-char company identification
 * @param {string} opts.fileIdModifier   A-Z / 0-9, unique per file per day
 * @param {Date}   [opts.now]
 * @param {Array}  opts.batches          [{ secCode, entryDescription, effectiveDate: Date,
 *                                          entries: [{ transactionCode, routing, account,
 *                                          amountCents, individualId, individualName, traceNumber }] }]
 */
export function buildAchFile(opts) {
  const now = opts.now ?? new Date();
  const lines = [];
  let fileEntryCount = 0;
  let fileEntryHash = 0;
  let fileDebit = 0;
  let fileCredit = 0;

  // 1 - File Header
  lines.push(
    record(
      '1',
      '01',
      ' ' + num(opts.odfiRouting, 9), // immediate destination
      alpha(opts.companyId, 10), // immediate origin
      yymmdd(now),
      hhmm(now),
      alpha(opts.fileIdModifier, 1),
      '094',
      '10',
      '1',
      alpha(opts.odfiName, 23),
      alpha(opts.companyName, 23),
      alpha('', 8),
    ),
  );

  opts.batches.forEach((batch, i) => {
    const batchNumber = num(i + 1, 7);
    const odfiId = opts.odfiRouting.slice(0, 8);
    const hasDebits = batch.entries.some((e) => isDebitCode(e.transactionCode));
    const hasCredits = batch.entries.some((e) => !isDebitCode(e.transactionCode));
    const serviceClass = hasDebits && hasCredits ? '200' : hasDebits ? '225' : '220';

    // 5 - Batch Header
    lines.push(
      record(
        '5',
        serviceClass,
        alpha(opts.companyName, 16),
        alpha('', 20),
        alpha(opts.companyId, 10),
        alpha(batch.secCode, 3),
        alpha(batch.entryDescription, 10),
        alpha('', 6),
        yymmdd(batch.effectiveDate),
        alpha('', 3), // settlement date, filled by the ACH operator
        '1',
        num(odfiId, 8),
        batchNumber,
      ),
    );

    let entryHash = 0;
    let debit = 0;
    let credit = 0;

    // 6 - Entry Detail
    for (const e of batch.entries) {
      lines.push(
        record(
          '6',
          num(e.transactionCode, 2),
          num(e.routing.slice(0, 8), 8),
          num(e.routing[8], 1),
          alpha(e.account, 17),
          num(e.amountCents, 10),
          alpha(e.individualId, 15),
          alpha(e.individualName, 22),
          alpha('', 2),
          '0',
          num(e.traceNumber, 15),
        ),
      );
      entryHash += Number(e.routing.slice(0, 8));
      if (isDebitCode(e.transactionCode)) debit += e.amountCents;
      else credit += e.amountCents;
    }

    entryHash %= 1e10;

    // 8 - Batch Control
    lines.push(
      record(
        '8',
        serviceClass,
        num(batch.entries.length, 6),
        num(entryHash, 10),
        num(debit, 12),
        num(credit, 12),
        alpha(opts.companyId, 10),
        alpha('', 19),
        alpha('', 6),
        num(odfiId, 8),
        batchNumber,
      ),
    );

    fileEntryCount += batch.entries.length;
    fileEntryHash += entryHash;
    fileDebit += debit;
    fileCredit += credit;
  });

  fileEntryHash %= 1e10;
  const recordCount = lines.length + 1; // + file control
  const blockCount = Math.ceil(recordCount / BLOCKING_FACTOR);

  // 9 - File Control
  lines.push(
    record(
      '9',
      num(opts.batches.length, 6),
      num(blockCount, 6),
      num(fileEntryCount, 8),
      num(fileEntryHash, 10),
      num(fileDebit, 12),
      num(fileCredit, 12),
      alpha('', 39),
    ),
  );

  while (lines.length % BLOCKING_FACTOR !== 0) lines.push('9'.repeat(RECORD_LENGTH));

  return {
    content: lines.join('\n') + '\n',
    batchCount: opts.batches.length,
    entryCount: fileEntryCount,
    entryHash: fileEntryHash,
    totalDebitCents: fileDebit,
    totalCreditCents: fileCredit,
  };
}

function isDebitCode(code) {
  return ['27', '28', '37', '38'].includes(String(code));
}

/**
 * Parses and validates a NACHA file (used by the mock bank, the way a real ODFI would
 * reject a malformed file). Returns { entries, errors }.
 */
export function parseAchFile(content) {
  const errors = [];
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  const entries = [];

  if (lines.length % BLOCKING_FACTOR !== 0) errors.push('Line count is not a multiple of 10');
  lines.forEach((l, i) => {
    if (l.length !== RECORD_LENGTH) errors.push(`Line ${i + 1} is ${l.length} chars, expected 94`);
  });

  let hash = 0;
  let debit = 0;
  let credit = 0;
  let fileControl = null;

  for (const l of lines) {
    const type = l[0];
    if (type === '6') {
      const entry = {
        transactionCode: l.slice(1, 3),
        routing: l.slice(3, 12),
        account: l.slice(12, 29).trim(),
        amountCents: Number(l.slice(29, 39)),
        individualId: l.slice(39, 54).trim(),
        individualName: l.slice(54, 76).trim(),
        traceNumber: l.slice(79, 94),
      };
      entries.push(entry);
      hash += Number(entry.routing.slice(0, 8));
      if (isDebitCode(entry.transactionCode)) debit += entry.amountCents;
      else credit += entry.amountCents;
    } else if (type === '9' && !/^9+$/.test(l)) {
      fileControl = {
        entryCount: Number(l.slice(13, 21)),
        entryHash: Number(l.slice(21, 31)),
        totalDebit: Number(l.slice(31, 43)),
        totalCredit: Number(l.slice(43, 55)),
      };
    }
  }

  if (!lines[0]?.startsWith('1')) errors.push('Missing file header record');
  if (!fileControl) {
    errors.push('Missing file control record');
  } else {
    if (fileControl.entryCount !== entries.length) errors.push('File control entry count mismatch');
    if (fileControl.entryHash !== hash % 1e10) errors.push('File control entry hash mismatch');
    if (fileControl.totalDebit !== debit) errors.push('File control total debit mismatch');
    if (fileControl.totalCredit !== credit) errors.push('File control total credit mismatch');
  }

  return { entries, errors };
}
