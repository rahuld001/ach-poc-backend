import { DISABLING_RETURN_CODES, RETURN_CODES } from '../ach.js';
import { applyStatusChange } from './ledger.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details; // optional structured data for the client, e.g. failed checks
  }
}

/**
 * Updates a transfer's status, writes an audit event and moves the simulated money on the operating account,
 * inside the caller's transaction. Every rail and every path (bank files, sandbox, Increase) goes through here.
 */
export async function setTransferStatus(client, transferId, status, note, extra = {}) {
  const { rows: [prev] } = await client.query('SELECT * FROM transfers WHERE id = $1', [transferId]);
  const cols = Object.keys(extra);
  const sets = cols.map((c, i) => `${c} = $${i + 3}`);
  await client.query(
    `UPDATE transfers SET status = $2, updated_at = now()${sets.length ? ', ' + sets.join(', ') : ''} WHERE id = $1`,
    [transferId, status, ...cols.map((c) => extra[c])],
  );
  await client.query('INSERT INTO transfer_events (transfer_id, status, note) VALUES ($1, $2, $3)', [
    transferId,
    status,
    note ?? null,
  ]);
  if (prev) await applyStatusChange(client, prev, status);
}

/** Marks a transfer returned and disables the bank account if the return code requires it. */
export async function returnTransfer(client, transfer, returnCode, source) {
  const reason = RETURN_CODES[returnCode] ?? 'Unknown return reason';
  await setTransferStatus(client, transfer.id, 'returned', `${returnCode} ${reason} (${source})`, {
    return_code: returnCode,
    return_reason: reason,
  });
  if (DISABLING_RETURN_CODES.has(returnCode)) {
    await client.query(`UPDATE bank_accounts SET status = 'disabled', disabled_reason = $2 WHERE id = $1`, [
      transfer.bank_account_id,
      `${returnCode} ${reason}`,
    ]);
  }
}
