// Simulated ODFI and receiving banks, in-process. It behaves the way the real bank side does, on a compressed clock
// (SIM_BANKING_DAY_SECONDS per banking day):
//   1. acknowledges each delivered file after validating it exactly as an ODFI would (or rejects it),
//   2. returns entries as a real NACHA return file (addenda 99) one banking day after settlement for R01-type
//      codes, or three banking days later for unauthorized returns such as R10,
//   3. sends notifications of change (COR batch, addenda 98) for the test accounts that need corrections.
// Settlement itself is handled by odfi/index.js, since it works the same for every transport.
import { query, withTx } from '../../db.js';
import { decrypt, decryptIfEncrypted } from '../../crypto.js';
import { ORIGINATOR, SIM } from '../../config.js';
import { buildAchFile, parseAchFile, RETURN_CODES_BY_ORIGINAL } from '../../nacha.js';
import {
  TEST_ACCOUNT_OUTCOMES, TEST_NOC_OUTCOMES, UNAUTHORIZED_RETURN_CODES, entryDescriptionFor, transactionCode,
} from '../../ach.js';
import { setTransferStatus } from '../transfers.js';
import { applyInboundFile } from '../inbound.js';

/** In-process: there is nothing to transmit. The file is picked up by acknowledgeDueFiles. */
export async function send() {}

/** ODFI intake: validates each delivered file and acknowledges or rejects it. Returns how many files. */
export async function acknowledgeDueFiles({ force = false } = {}) {
  return withTx(async (client) => {
    const { rows: files } = await client.query(
      `SELECT * FROM ach_files
        WHERE kind = 'origination' AND status = 'submitted' AND transport = 'mock' AND ($1 OR process_after <= now())
        ORDER BY created_at FOR UPDATE SKIP LOCKED`,
      [force],
    );
    for (const file of files) {
      const { batches, entries, errors, totals } = parseAchFile(decryptIfEncrypted(file.content));
      const { rows: transfers } = await client.query(`SELECT * FROM transfers WHERE ach_file_id = $1 AND status = 'submitted'`, [file.id]);
      if (errors.length) {
        for (const t of transfers) await setTransferStatus(client, t.id, 'failed', `${ORIGINATOR.odfiName} rejected the file: ${errors[0]}`);
        await client.query(`UPDATE ach_files SET status = 'rejected', processed_at = now(), bank_response = $2 WHERE id = $1`, [
          file.id,
          JSON.stringify({ ack: { accepted: false, errors } }),
        ]);
        continue;
      }
      for (const t of transfers) {
        await setTransferStatus(client, t.id, 'accepted', `${ORIGINATOR.odfiName} acknowledged file ${file.file_name}; settles on ${t.effective_date}`);
      }
      await client.query(`UPDATE ach_files SET status = 'accepted', acknowledged_at = now(), bank_response = $2 WHERE id = $1`, [
        file.id,
        JSON.stringify({
          ack: {
            accepted: true,
            message: `File received and validated by ${ORIGINATOR.odfiName}`,
            batches: batches.length,
            entries: entries.length,
            total_debit_cents: totals.debitCents,
            total_credit_cents: totals.creditCents,
          },
        }),
      ]);
    }
    return files.length;
  });
}

const dueAfterDays = (since, days, force) => force || Date.now() - new Date(since).getTime() >= days * SIM.bankingDaySeconds * 1000;

/** Return code the simulated receiving bank sends for this entry, if any. */
function returnCodeFor(t) {
  const code = TEST_ACCOUNT_OUTCOMES[t.last4];
  if (!code) return null;
  // Insufficient funds and "not authorized" only make sense for a customer payment debit.
  if (['R01', 'R10'].includes(code) && !(t.direction === 'debit' && t.purpose === 'payment')) return null;
  return code;
}

/**
 * The receiving banks' side: finds settled entries that should come back and sends one return file with all of them
 * (returns in batches per SEC code, NOCs in a COR batch). Returns how many files were produced (0 or 1).
 */
export async function collectInbound({ force = false } = {}) {
  const { rows } = await query(
    `SELECT t.*, a.last4, a.routing_number, a.account_number_enc, a.account_type, a.holder_name,
            EXISTS (SELECT 1 FROM account_changes c WHERE c.bank_account_id = a.id) AS account_corrected
       FROM transfers t JOIN bank_accounts a ON a.id = t.bank_account_id
      WHERE t.rail = 'mock' AND t.status = 'settled' AND t.settled_at IS NOT NULL
      ORDER BY t.settled_at`,
  );
  const returns = [];
  const nocs = [];
  const nocAccounts = new Set(); // one NOC per account per file: once corrected, the data is right
  for (const t of rows) {
    const code = returnCodeFor(t);
    if (code && dueAfterDays(t.settled_at, UNAUTHORIZED_RETURN_CODES.includes(code) ? 3 : 1, force)) returns.push({ t, code });
    const noc = TEST_NOC_OUTCOMES[t.last4];
    if (noc && !t.account_corrected && !nocAccounts.has(t.bank_account_id) && dueAfterDays(t.settled_at, 1, force)) {
      nocAccounts.add(t.bank_account_id);
      nocs.push({ t, code: noc });
    }
  }
  if (!returns.length && !nocs.length) return 0;
  await deliverReturnFile(returns, nocs);
  return 1;
}

/** Sandbox button: the receiving bank returns one specific entry right now. */
export async function simulateReturn(t, code) {
  const { rows: [full] } = await query(
    `SELECT t.*, a.last4, a.routing_number, a.account_number_enc, a.account_type, a.holder_name
       FROM transfers t JOIN bank_accounts a ON a.id = t.bank_account_id WHERE t.id = $1`,
    [t.id],
  );
  return deliverReturnFile([{ t: full, code }], []);
}

/** Builds the NACHA return file the ODFI would hand us and runs it through the normal inbound processing. */
async function deliverReturnFile(returns, nocs) {
  const rdfiTrace = async (routing) => {
    const { rows: [{ seq }] } = await query(`SELECT nextval('rdfi_trace_seq') AS seq`);
    return routing.slice(0, 8) + String(seq).padStart(7, '0');
  };
  const entryFor = async (t, amountCents, addenda) => ({
    transactionCode: RETURN_CODES_BY_ORIGINAL[transactionCode(t.direction, t.account_type)],
    routing: t.routing_number,
    account: decrypt(t.account_number_enc),
    amountCents,
    individualId: t.id.replace(/-/g, '').slice(0, 15),
    individualName: t.holder_name,
    paymentTypeCode: t.sec_code === 'WEB' ? 'S' : undefined,
    traceNumber: await rdfiTrace(t.routing_number),
    addenda: { ...addenda, originalTraceNumber: t.trace_number, originalRdfi: t.routing_number.slice(0, 8) },
  });

  const batches = [];
  // Returns keep the original batch characteristics (SEC code, entry description).
  const groups = new Map();
  for (const { t, code } of returns) {
    const key = `${t.sec_code}|${entryDescriptionFor(t)}`;
    if (!groups.has(key)) groups.set(key, { secCode: t.sec_code, entryDescription: entryDescriptionFor(t), entries: [] });
    groups.get(key).entries.push(await entryFor(t, t.amount_cents, { typeCode: '99', returnReasonCode: code }));
  }
  batches.push(...groups.values());
  if (nocs.length) {
    const entries = [];
    for (const { t, code } of nocs) {
      entries.push(await entryFor(t, 0, { typeCode: '98', changeCode: code, correctedData: correctedDataFor(t, code) }));
    }
    batches.push({ secCode: 'COR', entryDescription: 'NOC', serviceClass: '200', entries });
  }

  const now = new Date();
  const file = buildAchFile({
    odfiRouting: ORIGINATOR.odfiRouting,
    odfiName: ORIGINATOR.odfiName,
    companyName: ORIGINATOR.companyName,
    companyId: ORIGINATOR.companyId,
    // The ODFI sends the file back to us: destination is our company, origin is the bank.
    immediateOrigin: ' ' + ORIGINATOR.odfiRouting,
    destinationName: ORIGINATOR.companyName,
    originName: ORIGINATOR.odfiName,
    fileIdModifier: 'R',
    lineEnding: ORIGINATOR.lineEnding,
    now,
    batches: batches.map((b) => ({ ...b, effectiveDate: now })),
  });
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return applyInboundFile(file.content, { transport: 'mock', fileName: `RETURNS_${stamp}.ach` });
}

/** What the simulated receiving bank says the correct account data is. */
function correctedDataFor(t, code) {
  const account = decrypt(t.account_number_enc);
  if (code === 'C01') return (account.slice(0, -4) + '9' + account.slice(-3)).padEnd(17, ' ');
  if (code === 'C02') return t.routing_number === '011401533' ? '021000021' : '011401533';
  return '';
}
