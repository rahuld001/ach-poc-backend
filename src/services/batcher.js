import { withTx } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';
import { ORIGINATOR, SIM } from '../config.js';
import { buildAchFile } from '../nacha.js';
import { entryDescriptionFor, nextBusinessDay, toIsoDate, transactionCode } from '../ach.js';
import { setTransferStatus } from './transfers.js';
import { transport, transportName } from './odfi/index.js';

const MODIFIERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Collects all pending direct-ACH transfers into one NACHA file (one batch per SEC code and entry description),
 * delivers it to the ODFI through the configured transport and marks the entries submitted. Returns the created
 * file row, or null if nothing was pending.
 */
export async function runBatch() {
  return withTx(async (client) => {
    // One batch run at a time, so two runs cannot pick the same file ID modifier for the day.
    await client.query('SELECT pg_advisory_xact_lock(820001)');
    const { rows: pending } = await client.query(
      `SELECT t.*, a.routing_number, a.account_number_enc, a.account_type, a.holder_name, a.status AS account_status
         FROM transfers t JOIN bank_accounts a ON a.id = t.bank_account_id
        WHERE t.status = 'pending' AND t.rail = 'mock'
        ORDER BY t.created_at
        FOR UPDATE OF t SKIP LOCKED`,
    );

    const ready = [];
    for (const t of pending) {
      // Micro-deposits go out while the account is still pending verification; everything else needs a verified account.
      const ok = t.account_status === 'verified' || (t.purpose === 'micro_deposit' && t.account_status === 'pending_verification');
      if (!ok) {
        await setTransferStatus(client, t.id, 'failed', `Bank account is ${t.account_status}`);
      } else {
        ready.push(t);
      }
    }
    if (ready.length === 0) return null;

    const { rows: [{ count }] } = await client.query(
      `SELECT count(*)::int AS count FROM ach_files WHERE kind = 'origination' AND created_at::date = current_date`,
    );
    // Nacha wants the modifier unique per origin per day; after 36 files it has to repeat, so warn.
    if (count >= MODIFIERS.length) console.warn(`[batcher] ${count} files already today: file ID modifier will repeat`);
    const fileIdModifier = MODIFIERS[count % MODIFIERS.length];
    const effectiveDate = nextBusinessDay();
    const nextTrace = async () => {
      const { rows: [{ seq }] } = await client.query(`SELECT nextval('trace_seq') AS seq`);
      return ORIGINATOR.odfiRouting.slice(0, 8) + String(seq).padStart(7, '0');
    };

    // One batch per SEC code + entry description (PAYMENT, PAYOUT, ACCTVERIFY, REVERSAL).
    const groups = new Map();
    for (const t of ready) {
      t.trace_number = await nextTrace();
      const description = entryDescriptionFor(t);
      const key = `${t.sec_code}|${description}`;
      if (!groups.has(key)) groups.set(key, { secCode: t.sec_code, entryDescription: description, transfers: [] });
      groups.get(key).transfers.push(t);
    }

    const batches = [];
    for (const g of groups.values()) {
      const entries = g.transfers.map((t) => ({
        transactionCode: transactionCode(t.direction, t.account_type),
        routing: t.routing_number,
        account: decrypt(t.account_number_enc),
        amountCents: t.amount_cents,
        individualId: t.id.replace(/-/g, '').slice(0, 15),
        individualName: t.holder_name,
        traceNumber: t.trace_number,
      }));
      if (ORIGINATOR.balanced) {
        // Offsetting entry to our own account so the batch nets to zero (some ODFIs require balanced files).
        const debit = g.transfers.filter((t) => t.direction === 'debit').reduce((s, t) => s + t.amount_cents, 0);
        const credit = g.transfers.filter((t) => t.direction === 'credit').reduce((s, t) => s + t.amount_cents, 0);
        if (debit !== credit) {
          entries.push({
            transactionCode: debit > credit ? '22' : '27',
            routing: ORIGINATOR.companyRouting,
            account: ORIGINATOR.companyAccount,
            amountCents: Math.abs(debit - credit),
            individualId: 'OFFSET',
            individualName: ORIGINATOR.companyName,
            traceNumber: await nextTrace(),
          });
        }
      }
      batches.push({
        secCode: g.secCode,
        entryDescription: g.entryDescription,
        paymentTypeCode: g.secCode === 'WEB' ? 'S' : undefined, // each WEB debit is a single-entry authorization
        effectiveDate,
        entries,
      });
    }

    const file = buildAchFile({ ...ORIGINATOR, fileIdModifier, batches });
    const now = new Date();
    // BANK-SPECIFIC naming: ACH_FILE_NAME_TEMPLATE with {companyId} {date} {time} {modifier}.
    const pad = (n) => String(n).padStart(2, '0');
    const fileName = (process.env.ACH_FILE_NAME_TEMPLATE || '{companyId}_{date}_{modifier}.ach')
      .replaceAll('{companyId}', ORIGINATOR.companyId)
      .replaceAll('{date}', toIsoDate(now).replace(/-/g, ''))
      .replaceAll('{time}', pad(now.getHours()) + pad(now.getMinutes()))
      .replaceAll('{modifier}', fileIdModifier);

    const { rows: [row] } = await client.query(
      `INSERT INTO ach_files (kind, file_id_modifier, content, batch_count, entry_count, entry_hash, total_debit_cents,
                              total_credit_cents, status, process_after, settles_at, effective_date, file_name, transport)
       VALUES ('origination', $1, $2, $3, $4, $5, $6, $7, 'submitted',
               now() + make_interval(secs => $8), now() + make_interval(secs => $9), $10, $11, $12)
       RETURNING id, kind, file_id_modifier, batch_count, entry_count, total_debit_cents, total_credit_cents, status,
                 process_after, settles_at, effective_date, file_name, transport, created_at`,
      // The file holds full account numbers, so it is encrypted at rest like the accounts themselves.
      [fileIdModifier, encrypt(file.content), file.batchCount, file.entryCount, file.entryHash, file.totalDebitCents,
       file.totalCreditCents, SIM.ackSeconds, SIM.bankingDaySeconds, toIsoDate(effectiveDate), fileName, transportName],
    );

    for (const t of ready) {
      await setTransferStatus(client, t.id, 'submitted', `Included in file ${fileName}, sent to ${ORIGINATOR.odfiName} (${transportName})`, {
        trace_number: t.trace_number,
        ach_file_id: row.id,
        effective_date: toIsoDate(effectiveDate),
      });
    }

    // Deliver inside the transaction: if the upload fails, everything above rolls back and is retried next run.
    await transport.send({ id: row.id, fileName, content: file.content });
    return row;
  });
}
