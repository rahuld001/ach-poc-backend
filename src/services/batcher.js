import { withTx } from '../db.js';
import { decrypt } from '../crypto.js';
import { buildAchFile } from '../nacha.js';
import { nextBusinessDay, secCodeFor, toIsoDate, transactionCode } from '../ach.js';
import { setTransferStatus } from './transfers.js';

const MODIFIERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Collects all pending transfers into one NACHA file (one batch per SEC code) and
 * "submits" it to the mock bank. Returns the created file row, or null if nothing was pending.
 */
export async function runBatch() {
  return withTx(async (client) => {
    const { rows: pending } = await client.query(
      `SELECT t.*, a.routing_number, a.account_number_enc, a.account_type, a.holder_name, a.status AS account_status
         FROM transfers t JOIN bank_accounts a ON a.id = t.bank_account_id
        WHERE t.status = 'pending' AND t.rail = 'mock'
        ORDER BY t.created_at
        FOR UPDATE OF t SKIP LOCKED`,
    );

    const ready = [];
    for (const t of pending) {
      if (t.account_status !== 'verified') {
        await setTransferStatus(client, t.id, 'failed', 'Bank account is no longer verified');
      } else {
        ready.push(t);
      }
    }
    if (ready.length === 0) return null;

    const { rows: [{ count }] } = await client.query(
      `SELECT count(*)::int AS count FROM ach_files WHERE created_at::date = current_date`,
    );
    const fileIdModifier = MODIFIERS[count % MODIFIERS.length];
    const odfiRouting = process.env.ODFI_ROUTING || '011000015';
    const effectiveDate = nextBusinessDay();

    const bySec = new Map();
    for (const t of ready) {
      const { rows: [{ seq }] } = await client.query(`SELECT nextval('trace_seq') AS seq`);
      t.trace_number = odfiRouting.slice(0, 8) + String(seq).padStart(7, '0');
      if (!bySec.has(t.sec_code)) bySec.set(t.sec_code, []);
      bySec.get(t.sec_code).push(t);
    }

    const file = buildAchFile({
      odfiRouting,
      odfiName: process.env.ODFI_NAME || 'SIMULATED BANK',
      companyName: process.env.COMPANY_NAME || 'ACH POC INC',
      companyId: process.env.COMPANY_ID || '1234567890',
      fileIdModifier,
      batches: [...bySec.entries()].map(([secCode, transfers]) => ({
        secCode,
        entryDescription: secCode === secCodeFor('debit') ? 'PAYMENT' : 'PAYOUT',
        effectiveDate,
        entries: transfers.map((t) => ({
          transactionCode: transactionCode(t.direction, t.account_type),
          routing: t.routing_number,
          account: decrypt(t.account_number_enc),
          amountCents: t.amount_cents,
          individualId: t.id.replace(/-/g, '').slice(0, 15),
          individualName: t.holder_name,
          traceNumber: t.trace_number,
        })),
      })),
    });

    const delay = Number(process.env.MOCK_BANK_DELAY_SECONDS ?? 15);
    const { rows: [row] } = await client.query(
      `INSERT INTO ach_files (file_id_modifier, content, batch_count, entry_count, entry_hash,
                              total_debit_cents, total_credit_cents, status, process_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'submitted', now() + make_interval(secs => $8))
       RETURNING id, file_id_modifier, batch_count, entry_count, total_debit_cents, total_credit_cents, status, process_after, created_at`,
      [fileIdModifier, file.content, file.batchCount, file.entryCount, file.entryHash,
       file.totalDebitCents, file.totalCreditCents, delay],
    );

    for (const t of ready) {
      await setTransferStatus(client, t.id, 'submitted', `Included in ACH file ${row.id.slice(0, 8)} (modifier ${fileIdModifier})`, {
        trace_number: t.trace_number,
        ach_file_id: row.id,
        effective_date: toIsoDate(effectiveDate),
      });
    }
    return row;
  });
}
