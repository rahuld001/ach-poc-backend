// The bank side of direct ACH. A transport delivers origination files to the ODFI and brings back acknowledgments
// and return / NOC files. Settlement is never reported by a bank: an entry settles when its effective date is reached,
// so that step is common to every transport.
import { withTx } from '../../db.js';
import { ODFI_TRANSPORT } from '../../config.js';
import { RETURN_WINDOW_BANKING_DAYS, addBankingDays, parseIsoDate, toIsoDate } from '../../ach.js';
import { setTransferStatus } from '../transfers.js';
import * as mock from './mock.js';
import * as sftp from './sftp.js';

export const transportName = ODFI_TRANSPORT;
export const transport = transportName === 'sftp' ? sftp : mock;

/** Marks one entry settled: funds moved on the effective date; debits stay returnable for 2 banking days. */
export async function settleTransfer(client, t, note) {
  const effective = t.effective_date ? parseIsoDate(t.effective_date) : new Date();
  await setTransferStatus(client, t.id, 'settled', note, {
    settled_at: new Date(),
    return_window_ends: toIsoDate(addBankingDays(effective, RETURN_WINDOW_BANKING_DAYS)),
  });
}

/** Settles every accepted file whose effective date (simulated clock) has arrived. Returns how many files. */
export async function settleDueFiles({ force = false } = {}) {
  return withTx(async (client) => {
    const { rows: files } = await client.query(
      `SELECT * FROM ach_files
        WHERE kind = 'origination' AND status = 'accepted' AND ($1 OR settles_at <= now())
        ORDER BY created_at FOR UPDATE SKIP LOCKED`,
      [force],
    );
    for (const file of files) {
      const { rows: transfers } = await client.query(`SELECT * FROM transfers WHERE ach_file_id = $1 AND status = 'accepted'`, [file.id]);
      for (const t of transfers) {
        await settleTransfer(client, t, `Settled on effective date ${t.effective_date} (${t.direction === 'debit' ? 'funds collected; returns possible for 2 banking days' : 'funds delivered'})`);
      }
      await client.query(`UPDATE ach_files SET status = 'settled', processed_at = now() WHERE id = $1`, [file.id]);
    }
    return files.length;
  });
}

/** One tick of the bank side: acknowledge delivered files, settle due ones, pick up returns and NOCs. */
export async function runOdfiJobs({ force = false } = {}) {
  const acknowledged = await transport.acknowledgeDueFiles({ force });
  const settled = await settleDueFiles({ force });
  const inbound = await transport.collectInbound({ force });
  return { acknowledged, settled, inbound };
}
