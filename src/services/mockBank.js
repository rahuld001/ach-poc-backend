import { withTx } from '../db.js';
import { parseAchFile } from '../nacha.js';
import { TEST_ACCOUNT_OUTCOMES } from '../ach.js';
import { returnTransfer, setTransferStatus } from './transfers.js';

/**
 * Simulated ODFI. Picks up submitted files whose delay has elapsed, validates them like a
 * real bank would, then settles each entry or returns it based on the test account number.
 * Pass { force: true } to ignore the delay (sandbox "process now" button).
 */
export async function processDueFiles({ force = false } = {}) {
  return withTx(async (client) => {
    const { rows: files } = await client.query(
      `SELECT * FROM ach_files
        WHERE status = 'submitted' AND ($1 OR process_after <= now())
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED`,
      [force],
    );

    for (const file of files) {
      const { entries, errors } = parseAchFile(file.content);
      const { rows: transfers } = await client.query(
        `SELECT * FROM transfers WHERE ach_file_id = $1 AND status = 'submitted'`,
        [file.id],
      );

      if (errors.length > 0) {
        for (const t of transfers) {
          await setTransferStatus(client, t.id, 'failed', `Bank rejected file: ${errors[0]}`);
        }
        await client.query(
          `UPDATE ach_files SET status = 'rejected', processed_at = now(), bank_response = $2 WHERE id = $1`,
          [file.id, JSON.stringify({ errors })],
        );
        continue;
      }

      const byTrace = new Map(transfers.map((t) => [t.trace_number, t]));
      const results = [];
      for (const entry of entries) {
        const t = byTrace.get(entry.traceNumber);
        if (!t) continue; // already handled via sandbox simulate
        const returnCode = TEST_ACCOUNT_OUTCOMES[entry.account.slice(-4)];
        if (returnCode) {
          await returnTransfer(client, t, returnCode, 'mock bank');
          results.push({ trace: entry.traceNumber, outcome: 'returned', returnCode });
        } else {
          await setTransferStatus(client, t.id, 'settled', 'Settled by mock bank');
          results.push({ trace: entry.traceNumber, outcome: 'settled' });
        }
      }

      await client.query(
        `UPDATE ach_files SET status = 'processed', processed_at = now(), bank_response = $2 WHERE id = $1`,
        [file.id, JSON.stringify({ results })],
      );
    }
    return files.length;
  });
}
