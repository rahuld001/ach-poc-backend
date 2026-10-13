// The simulated operating account: where collected debits land and payouts are paid from. All amounts are
// simulated money. Rules follow what a bank does with an originator's account:
//   - a payout (credit to a customer) is held when created and paid when it settles,
//   - a collection (debit from a customer) is credited when it settles,
//   - a returned collection is taken back, a returned payout comes back, and every return costs a fee,
//   - cancelled or failed payouts release their hold.
import { query } from '../db.js';
import { isTestMode } from '../config.js';
import { HttpError } from './transfers.js';

export const RETURN_FEE_CENTS = Number(process.env.RETURN_FEE_CENTS ?? 250);
const OPENING_BALANCE_CENTS = Number(process.env.SIM_OPENING_BALANCE_CENTS ?? 1_000_000); // $10,000 of simulated money in test mode

/** Locks the account row (creating it, with an opening balance in test mode, on first use). */
export async function lockAccount(client) {
  let { rows: [acct] } = await client.query('SELECT * FROM operating_account WHERE id = 1 FOR UPDATE');
  if (!acct) {
    await client.query('INSERT INTO operating_account (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    ({ rows: [acct] } = await client.query('SELECT * FROM operating_account WHERE id = 1 FOR UPDATE'));
    if (isTestMode && OPENING_BALANCE_CENTS > 0) {
      acct = await post(client, { type: 'opening', amountCents: OPENING_BALANCE_CENTS, note: 'Opening balance (simulated money for the demo)' }, acct);
    }
  }
  return acct;
}

/** Adds a ledger entry and moves the balance. Returns the updated account row. */
export async function post(client, { type, amountCents, note, transferId = null }, acct) {
  acct ??= await lockAccount(client);
  const balance = Number(acct.balance_cents) + amountCents;
  await client.query('INSERT INTO ledger_entries (transfer_id, type, amount_cents, balance_after, note) VALUES ($1, $2, $3, $4, $5)', [
    transferId, type, amountCents, balance, note ?? null,
  ]);
  const { rows: [updated] } = await client.query('UPDATE operating_account SET balance_cents = $1, updated_at = now() WHERE id = 1 RETURNING *', [balance]);
  return updated;
}

async function adjustHold(client, deltaCents) {
  await client.query('UPDATE operating_account SET held_cents = greatest(0, held_cents + $1), updated_at = now() WHERE id = 1', [deltaCents]);
}

const isPayout = (t) => t.direction === 'credit';

/** Reserves the money for a new payout; refuses it when the available balance cannot cover it. */
export async function holdForTransfer(client, t) {
  if (!isPayout(t)) return;
  const acct = await lockAccount(client);
  const available = Number(acct.balance_cents) - Number(acct.held_cents);
  if (available < t.amount_cents) {
    throw new HttpError(400, `Insufficient operating balance: $${(available / 100).toFixed(2)} available for a $${(t.amount_cents / 100).toFixed(2)} payout. Fund the operating account (Go Live, step 5).`, {
      available_cents: available,
    });
  }
  await adjustHold(client, t.amount_cents);
}

/**
 * Applies the money movement for a status change. `prev` is the transfer row before the change, `status` the new
 * status. Called by setTransferStatus so every rail and every path (bank files, sandbox, Increase) is covered.
 */
export async function applyStatusChange(client, prev, status) {
  const label = `${prev.direction === 'debit' ? 'Collection' : 'Payout'} ${prev.trace_number ?? prev.id.slice(0, 8)}`;
  const wasSettled = prev.status === 'settled';
  const money = { transferId: prev.id };

  if (status === 'settled' && !wasSettled) {
    await lockAccount(client);
    if (isPayout(prev)) {
      await adjustHold(client, -prev.amount_cents);
      await post(client, { ...money, type: prev.purpose === 'reversal' ? 'reversal' : 'payout', amountCents: -prev.amount_cents, note: `${label} settled` });
    } else {
      await post(client, { ...money, type: prev.purpose === 'reversal' ? 'reversal' : 'collection', amountCents: prev.amount_cents, note: `${label} settled` });
    }
  } else if (status === 'returned' && prev.status !== 'returned') {
    await lockAccount(client);
    if (wasSettled) {
      await post(client, { ...money, type: 'return', amountCents: isPayout(prev) ? prev.amount_cents : -prev.amount_cents, note: `${label} returned` });
    } else if (isPayout(prev)) {
      await adjustHold(client, -prev.amount_cents); // never left the account
    }
    if (RETURN_FEE_CENTS > 0) await post(client, { ...money, type: 'return_fee', amountCents: -RETURN_FEE_CENTS, note: `Return fee for ${label}` });
  } else if (['cancelled', 'failed'].includes(status) && isPayout(prev) && !wasSettled && !['cancelled', 'failed', 'returned'].includes(prev.status)) {
    await lockAccount(client);
    await adjustHold(client, -prev.amount_cents);
  }
}

/** Balance, hold and recent entries for the UI. */
export async function summary() {
  const { rows: [acct] } = await query('SELECT * FROM operating_account WHERE id = 1');
  const balance = Number(acct?.balance_cents ?? 0);
  const held = Number(acct?.held_cents ?? 0);
  const { rows: entries } = await query(
    `SELECT l.id, l.type, l.amount_cents, l.balance_after, l.note, l.created_at, l.transfer_id
       FROM ledger_entries l ORDER BY l.id DESC LIMIT 50`,
  );
  return { balance_cents: balance, held_cents: held, available_cents: balance - held, return_fee_cents: RETURN_FEE_CENTS, entries, simulated: true };
}
