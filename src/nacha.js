// NACHA file builder / parser. Every record is exactly 94 characters; the file is
// padded with all-9 records to a multiple of 10 lines (blocking factor 10).
//
// Record types: 1 file header, 5 batch header, 6 entry detail, 7 addenda, 8 batch control, 9 file control.
// Outbound origination files carry entries. Inbound files from the bank carry returns (addenda type 99 with the
// return reason code) and notifications of change (COR batch, addenda type 98 with the change code).

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

export const DEBIT_CODES = ['27', '28', '37', '38'];
/** Transaction code a return or NOC entry uses for an original entry: 21/26 checking, 31/36 savings. */
export const RETURN_CODES_BY_ORIGINAL = { 22: '21', 23: '21', 27: '26', 28: '26', 32: '31', 33: '31', 37: '36', 38: '36' };
export const isDebitCode = (code) => DEBIT_CODES.includes(String(code));
export const isReturnCode = (code) => ['21', '26', '31', '36'].includes(String(code));
/** Prenotification (zero-dollar) entries. */
export const isPrenoteCode = (code) => ['23', '28', '33', '38'].includes(String(code));

// For control totals: debits, plus returned debits (26/36), count on the debit side.
function isDebitForTotals(code) {
  return isDebitCode(code) || ['26', '36'].includes(String(code));
}

/**
 * Builds a NACHA file.
 *
 * @param {object} opts
 * @param {string} opts.odfiRouting      9-digit routing of the originating bank (batch ODFI id, trace prefix)
 * @param {string} opts.companyName
 * @param {string} opts.companyId        10-char company identification
 * @param {string} opts.fileIdModifier   A-Z / 0-9, unique per file per day
 * @param {string} [opts.immediateDestination] 9-digit routing the file goes to (default: the ODFI)
 * @param {string} [opts.immediateOrigin]      10 chars (default: the company id)
 * @param {string} [opts.destinationName]      (default: odfiName)
 * @param {string} [opts.originName]           (default: companyName)
 * @param {string} [opts.odfiName]
 * @param {Date}   [opts.now]
 * @param {'LF'|'CRLF'} [opts.lineEnding]      Record separator; banks differ (default LF)
 * @param {Array}  opts.batches  [{ secCode, entryDescription, effectiveDate: Date, paymentTypeCode?, serviceClass?,
 *                                  companyName?, companyId?, odfiRouting?,
 *                                  entries: [{ transactionCode, routing, account, amountCents, individualId,
 *                                              individualName, traceNumber, paymentTypeCode?,
 *                                              addenda?: { typeCode: '99', returnReasonCode, originalTraceNumber,
 *                                                          dateOfDeath?, originalRdfi, addendaInfo? }
 *                                                       | { typeCode: '98', changeCode, originalTraceNumber,
 *                                                          originalRdfi, correctedData } }] }]
 *
 * WEB entries must carry a Payment Type Code in the discretionary data field (positions 77-78): 'S' for a
 * single entry or 'R' for recurring. It can be given per entry or once per batch.
 */
export function buildAchFile(opts) {
  const now = opts.now ?? new Date();
  const lines = [];
  let fileRecordCount = 0; // entries + addenda
  let fileEntryHash = 0;
  let fileDebit = 0;
  let fileCredit = 0;

  // 1 - File Header
  lines.push(
    record(
      '1',
      '01',
      ' ' + num(opts.immediateDestination ?? opts.odfiRouting, 9),
      alpha(opts.immediateOrigin ?? opts.companyId, 10),
      yymmdd(now),
      hhmm(now),
      alpha(opts.fileIdModifier, 1),
      '094',
      '10',
      '1',
      alpha(opts.destinationName ?? opts.odfiName, 23),
      alpha(opts.originName ?? opts.companyName, 23),
      alpha('', 8),
    ),
  );

  opts.batches.forEach((batch, i) => {
    const batchNumber = num(i + 1, 7);
    const odfiRouting = batch.odfiRouting ?? opts.odfiRouting;
    const odfiId = odfiRouting.slice(0, 8);
    const companyName = batch.companyName ?? opts.companyName;
    const companyId = batch.companyId ?? opts.companyId;
    const hasDebits = batch.entries.some((e) => isDebitForTotals(e.transactionCode));
    const hasCredits = batch.entries.some((e) => !isDebitForTotals(e.transactionCode));
    const serviceClass = batch.serviceClass ?? (hasDebits && hasCredits ? '200' : hasDebits ? '225' : '220');

    // 5 - Batch Header
    lines.push(
      record(
        '5',
        serviceClass,
        alpha(companyName, 16),
        alpha('', 20),
        alpha(companyId, 10),
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
    let recordCount = 0;

    // 6 - Entry Detail (+ 7 - Addenda)
    for (const e of batch.entries) {
      const discretionary = e.paymentTypeCode ?? batch.paymentTypeCode ?? '';
      if (batch.secCode === 'WEB' && !isReturnCode(e.transactionCode) && !['S', 'R'].includes(discretionary)) {
        throw new Error(`WEB entry ${e.traceNumber} needs a Payment Type Code of S or R (got "${discretionary}")`);
      }
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
          alpha(discretionary, 2), // discretionary data / WEB payment type code
          e.addenda ? '1' : '0',
          num(e.traceNumber, 15),
        ),
      );
      recordCount++;
      if (e.addenda) {
        lines.push(addendaRecord(e.addenda, e.traceNumber));
        recordCount++;
      }
      entryHash += Number(e.routing.slice(0, 8));
      if (isDebitForTotals(e.transactionCode)) debit += e.amountCents;
      else credit += e.amountCents;
    }

    entryHash %= 1e10;

    // 8 - Batch Control
    lines.push(
      record(
        '8',
        serviceClass,
        num(recordCount, 6),
        num(entryHash, 10),
        num(debit, 12),
        num(credit, 12),
        alpha(companyId, 10),
        alpha('', 19),
        alpha('', 6),
        num(odfiId, 8),
        batchNumber,
      ),
    );

    fileRecordCount += recordCount;
    fileEntryHash += entryHash;
    fileDebit += debit;
    fileCredit += credit;
  });

  fileEntryHash %= 1e10;
  const totalRecords = lines.length + 1; // + file control
  const blockCount = Math.ceil(totalRecords / BLOCKING_FACTOR);

  // 9 - File Control
  lines.push(
    record(
      '9',
      num(opts.batches.length, 6),
      num(blockCount, 6),
      num(fileRecordCount, 8),
      num(fileEntryHash, 10),
      num(fileDebit, 12),
      num(fileCredit, 12),
      alpha('', 39),
    ),
  );

  while (lines.length % BLOCKING_FACTOR !== 0) lines.push('9'.repeat(RECORD_LENGTH));

  const eol = opts.lineEnding === 'CRLF' ? '\r\n' : '\n';
  return {
    content: lines.join(eol) + eol,
    batchCount: opts.batches.length,
    entryCount: fileRecordCount,
    entryHash: fileEntryHash,
    totalDebitCents: fileDebit,
    totalCreditCents: fileCredit,
  };
}

/** Addenda record: type 99 (return) or 98 (notification of change). The RDFI assigns the trace number. */
function addendaRecord(a, traceNumber) {
  if (a.typeCode === '99') {
    return record(
      '7',
      '99',
      alpha(a.returnReasonCode, 3),
      num(a.originalTraceNumber, 15),
      alpha(a.dateOfDeath ?? '', 6),
      num(a.originalRdfi, 8),
      alpha(a.addendaInfo ?? '', 44),
      num(traceNumber, 15),
    );
  }
  if (a.typeCode === '98') {
    return record(
      '7',
      '98',
      alpha(a.changeCode, 3),
      num(a.originalTraceNumber, 15),
      alpha('', 6),
      num(a.originalRdfi, 8),
      alpha(a.correctedData, 29),
      alpha('', 15),
      num(traceNumber, 15),
    );
  }
  throw new Error(`Unsupported addenda type ${a.typeCode}`);
}

/**
 * Parses and validates a NACHA file: origination files (as an ODFI checks them) and inbound return / NOC files
 * from the bank. Returns { header, batches, entries, errors }. Each entry carries its batch's secCode and, when
 * present, its addenda (return reason or change code).
 */
export function parseAchFile(content) {
  const errors = [];
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  const entries = [];
  const batches = [];
  let header = null;

  if (lines.length % BLOCKING_FACTOR !== 0) errors.push('Line count is not a multiple of 10');
  lines.forEach((l, i) => {
    if (l.length !== RECORD_LENGTH) errors.push(`Line ${i + 1} is ${l.length} chars, expected 94`);
  });

  let hash = 0;
  let debit = 0;
  let credit = 0;
  let recordCount = 0;
  let fileControl = null;
  let batch = null;

  for (const l of lines) {
    const type = l[0];
    if (type === '1') {
      header = {
        immediateDestination: l.slice(3, 13).trim(),
        immediateOrigin: l.slice(13, 23).trim(),
        creationDate: l.slice(23, 29),
        creationTime: l.slice(29, 33),
        fileIdModifier: l[33],
        destinationName: l.slice(40, 63).trim(),
        originName: l.slice(63, 86).trim(),
      };
    } else if (type === '5') {
      batch = {
        serviceClass: l.slice(1, 4),
        companyName: l.slice(4, 20).trim(),
        companyId: l.slice(40, 50).trim(),
        secCode: l.slice(50, 53),
        entryDescription: l.slice(53, 63).trim(),
        effectiveDate: l.slice(69, 75),
        odfiId: l.slice(79, 87),
        batchNumber: Number(l.slice(87, 94)),
        entries: [],
      };
      batches.push(batch);
    } else if (type === '6') {
      const entry = {
        transactionCode: l.slice(1, 3),
        routing: l.slice(3, 12),
        account: l.slice(12, 29).trim(),
        amountCents: Number(l.slice(29, 39)),
        individualId: l.slice(39, 54).trim(),
        individualName: l.slice(54, 76).trim(),
        paymentTypeCode: l.slice(76, 78).trim(),
        hasAddenda: l[78] === '1',
        traceNumber: l.slice(79, 94),
        secCode: batch?.secCode ?? null,
        addenda: null,
      };
      entries.push(entry);
      batch?.entries.push(entry);
      recordCount++;
      hash += Number(entry.routing.slice(0, 8));
      if (isDebitForTotals(entry.transactionCode)) debit += entry.amountCents;
      else credit += entry.amountCents;
    } else if (type === '7') {
      recordCount++;
      const last = entries[entries.length - 1];
      if (!last) {
        errors.push('Addenda record without an entry');
        continue;
      }
      const typeCode = l.slice(1, 3);
      if (typeCode === '99') {
        last.addenda = {
          typeCode,
          returnReasonCode: l.slice(3, 6),
          originalTraceNumber: l.slice(6, 21),
          dateOfDeath: l.slice(21, 27).trim(),
          originalRdfi: l.slice(27, 35),
          addendaInfo: l.slice(35, 79).trim(),
          traceNumber: l.slice(79, 94),
        };
      } else if (typeCode === '98') {
        last.addenda = {
          typeCode,
          changeCode: l.slice(3, 6),
          originalTraceNumber: l.slice(6, 21),
          originalRdfi: l.slice(27, 35),
          correctedData: l.slice(35, 64).trimEnd(),
          traceNumber: l.slice(79, 94),
        };
      } else {
        last.addenda = { typeCode, paymentRelatedInformation: l.slice(3, 83).trim(), traceNumber: l.slice(79, 94) };
      }
    } else if (type === '9' && !/^9+$/.test(l)) {
      fileControl = {
        batchCount: Number(l.slice(1, 7)),
        entryCount: Number(l.slice(13, 21)),
        entryHash: Number(l.slice(21, 31)),
        totalDebit: Number(l.slice(31, 43)),
        totalCredit: Number(l.slice(43, 55)),
      };
    }
  }

  if (!header) errors.push('Missing file header record');
  if (!fileControl) {
    errors.push('Missing file control record');
  } else {
    if (fileControl.batchCount !== batches.length) errors.push('File control batch count mismatch');
    if (fileControl.entryCount !== recordCount) errors.push('File control entry/addenda count mismatch');
    if (fileControl.entryHash !== hash % 1e10) errors.push('File control entry hash mismatch');
    if (fileControl.totalDebit !== debit) errors.push('File control total debit mismatch');
    if (fileControl.totalCredit !== credit) errors.push('File control total credit mismatch');
  }

  return {
    header,
    batches,
    entries,
    errors,
    totals: { recordCount, entryHash: hash % 1e10, debitCents: debit, creditCents: credit },
  };
}

/**
 * Returns the file with every entry detail account number masked to its last 4 digits, for display.
 * The real file (with full account numbers) is only ever exchanged with the bank.
 */
export function maskAccountNumbers(content) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  return content
    .split(/\r?\n/)
    .map((l) => {
      if (l[0] !== '6' || l.length !== RECORD_LENGTH) return l;
      const account = l.slice(12, 29).trim();
      const masked = ('*'.repeat(Math.max(0, account.length - 4)) + account.slice(-4)).padEnd(17, ' ');
      return l.slice(0, 12) + masked + l.slice(29);
    })
    .join(eol);
}
