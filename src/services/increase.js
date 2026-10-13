// "Increase" rail: sends transfers through Increase's ACH API (https://increase.com/documentation/api/ach-transfers)
// instead of our own NACHA file + mock bank. Increase originates the ACH entries through its partner bank, so this
// is a real bank-to-bank ACH path. Status is polled; production would add webhooks.
import { query, withTx } from '../db.js';
import { decrypt } from '../crypto.js';
import { TEST_ACCOUNT_OUTCOMES } from '../ach.js';
import { returnTransfer, setTransferStatus } from './transfers.js';
import { increaseSandbox } from '../config.js';

const BASE_URL = (process.env.INCREASE_BASE_URL || 'https://sandbox.increase.com').replace(/\/+$/, '');
export const increaseEnabled = Boolean(process.env.INCREASE_API_KEY);
export { increaseSandbox };

// Our SEC codes -> Increase's standard_entry_class_code values.
const SEC_CODES = { WEB: 'internet_initiated', PPD: 'prearranged_payments_and_deposit' };

// R codes we simulate -> Increase's return reason enum (sandbox only).
const RETURN_REASONS = {
  R01: 'insufficient_fund',
  R02: 'account_closed',
  R03: 'no_account',
  R04: 'invalid_account_number_structure',
  R07: 'authorization_revoked_by_customer',
  R08: 'payment_stopped',
  R10: 'customer_advised_unauthorized_improper_ineligible_or_incomplete',
  R16: 'account_frozen_entry_returned_per_ofac_instruction',
  R29: 'corporate_customer_advised_not_authorized',
};

export class IncreaseError extends Error {
  constructor(status, body) {
    super(body?.detail || body?.title || `Increase API error (${status})`);
    this.status = status;
  }
}

async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.INCREASE_API_KEY}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new IncreaseError(res.status, data);
  return data;
}

// The Increase account that sends and receives the money: INCREASE_ACCOUNT_ID, or the first open account.
let accountId = process.env.INCREASE_ACCOUNT_ID;
async function originatingAccountId() {
  if (accountId) return accountId;
  const { data } = await call('GET', '/accounts?limit=10');
  accountId = data?.find((a) => a.status === 'open')?.id;
  if (!accountId) throw new Error('No open Increase account (set INCREASE_ACCOUNT_ID)');
  return accountId;
}

const ascii = (s, max) => String(s ?? '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, max);

/** Creates the transfer at Increase. The transfer id is the idempotency key, so retries never duplicate it. */
async function sendTransfer(t) {
  return call(
    'POST',
    '/ach_transfers',
    {
      account_id: await originatingAccountId(),
      amount: t.direction === 'debit' ? -t.amount_cents : t.amount_cents, // negative pulls funds, positive pushes
      account_number: decrypt(t.account_number_enc),
      routing_number: t.routing_number,
      funding: t.account_type === 'savings' ? 'savings' : 'checking',
      standard_entry_class_code: SEC_CODES[t.sec_code],
      statement_descriptor: ascii(t.description, 200) || (t.direction === 'debit' ? 'ACH payment' : 'ACH payout'),
      individual_name: ascii(t.holder_name, 22),
      individual_id: t.id.replace(/-/g, '').slice(0, 15),
      company_name: ascii(process.env.COMPANY_NAME || 'ACH POC INC', 16),
      company_entry_description: t.direction === 'debit' ? 'PAYMENT' : 'PAYOUT',
      destination_account_holder: 'individual',
    },
    { 'Idempotency-Key': t.id },
  );
}

const simulate = (id, step, body = {}) => call('POST', `/simulations/ach_transfers/${id}/${step}`, body);

/** Sandbox: moves a transfer to "submitted". Approval-gated transfers must be approved before they can be submitted. */
async function ensureSubmitted(remote) {
  if (remote.status === 'pending_approval') remote = await call('POST', `/ach_transfers/${remote.id}/approve`);
  if (['pending_submission', 'pending_reviewing'].includes(remote.status)) remote = await simulate(remote.id, 'submit');
  return remote;
}

/** Sends every pending Increase-rail transfer to Increase. Returns how many were sent. */
export async function sendPendingToIncrease() {
  if (!increaseEnabled) return 0;
  const { rows } = await query(
    `SELECT t.*, a.routing_number, a.account_number_enc, a.account_type, a.holder_name, a.status AS account_status
       FROM transfers t JOIN bank_accounts a ON a.id = t.bank_account_id
      WHERE t.status = 'pending' AND t.rail = 'increase' ORDER BY t.created_at`,
  );
  let sent = 0;
  for (const t of rows) {
    await withTx(async (client) => {
      const { rows: [locked] } = await client.query(`SELECT status FROM transfers WHERE id = $1 FOR UPDATE SKIP LOCKED`, [t.id]);
      if (locked?.status !== 'pending') return; // cancelled meanwhile, or another worker has it
      if (t.account_status !== 'verified') {
        await setTransferStatus(client, t.id, 'failed', 'Bank account is no longer verified');
        return;
      }
      try {
        const remote = await sendTransfer(t);
        await setTransferStatus(client, t.id, 'submitted', `Sent to Increase as ${remote.id} (${remote.status})`, {
          provider_transfer_id: remote.id,
        });
        sent++;
      } catch (err) {
        // 4xx means Increase rejected the request itself: fail it. Network or 5xx errors retry on the next run.
        if (err instanceof IncreaseError && err.status < 500) {
          await setTransferStatus(client, t.id, 'failed', `Increase rejected the transfer: ${err.message}`);
        } else {
          console.error('[increase] send failed, will retry:', err.message);
        }
      }
    });
  }
  return sent;
}

/** Applies Increase's latest state for one transfer: trace number, settlement, return, rejection. */
async function applyRemote(t, remote) {
  await withTx(async (client) => {
    const { rows: [cur] } = await client.query('SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [t.id]);
    if (!cur || !['submitted', 'settled'].includes(cur.status)) return;
    const sub = remote.submission;
    if (sub?.trace_number && !cur.trace_number) {
      await client.query('UPDATE transfers SET trace_number = $2, effective_date = $3 WHERE id = $1', [cur.id, sub.trace_number, sub.effective_date]);
    }
    if (remote.status === 'returned' && remote.return) {
      await returnTransfer(client, cur, remote.return.raw_return_reason_code, 'Increase');
    } else if (['rejected', 'canceled', 'requires_attention'].includes(remote.status)) {
      if (cur.status === 'submitted') await setTransferStatus(client, cur.id, 'failed', `Increase status: ${remote.status}`);
    } else if (remote.settlement && cur.status === 'submitted') {
      await setTransferStatus(client, cur.id, 'settled', `Settled via Increase (trace ${sub?.trace_number ?? 'n/a'})`);
    }
  });
}

/**
 * Polls Increase for submitted (and recently settled, for late returns) transfers. In the sandbox it also plays the
 * receiving bank after MOCK_BANK_DELAY_SECONDS: submits the entry, then settles it or returns it using the same
 * test account endings as the mock bank, so both rails behave the same in demos.
 */
const SETTLED_POLL_MS = 60_000; // late returns are rare: check settled transfers once a minute, not every 5 seconds
let lastSettledPoll = 0;

export async function syncIncrease() {
  if (!increaseEnabled) return;
  const delay = Number(process.env.MOCK_BANK_DELAY_SECONDS ?? 15);
  const includeSettled = Date.now() - lastSettledPoll >= SETTLED_POLL_MS;
  if (includeSettled) lastSettledPoll = Date.now();
  const { rows } = await query(
    `SELECT t.*, a.last4 FROM transfers t JOIN bank_accounts a ON a.id = t.bank_account_id
      WHERE t.rail = 'increase' AND t.provider_transfer_id IS NOT NULL
        AND (t.status = 'submitted' OR ($1 AND t.status = 'settled' AND t.updated_at > now() - interval '1 day'))`,
    [includeSettled],
  );
  for (const t of rows) {
    try {
      let remote = await call('GET', `/ach_transfers/${t.provider_transfer_id}`);
      const due = Date.now() - new Date(t.updated_at).getTime() >= delay * 1000;
      if (increaseSandbox && t.status === 'submitted' && due && !remote.settlement && remote.status !== 'returned') {
        remote = await ensureSubmitted(remote);
        const code = TEST_ACCOUNT_OUTCOMES[t.last4];
        remote = code ? await simulate(remote.id, 'return', { reason: RETURN_REASONS[code] }) : await simulate(remote.id, 'settle');
      }
      await applyRemote(t, remote);
    } catch (err) {
      console.error(`[increase] sync ${t.id}:`, err.message);
    }
  }
}

/** Sandbox buttons: settle or return an Increase-rail transfer right away. */
export async function simulateOnIncrease(t, action, returnCode) {
  if (!increaseSandbox) throw new Error('Simulations only work against the Increase sandbox');
  let remote = await ensureSubmitted(await call('GET', `/ach_transfers/${t.provider_transfer_id}`));
  if (action === 'settle') remote = await simulate(remote.id, 'settle');
  else {
    if (!RETURN_REASONS[returnCode]) throw new Error(`No Increase return reason mapped for ${returnCode}`);
    remote = await simulate(remote.id, 'return', { reason: RETURN_REASONS[returnCode] });
  }
  await applyRemote(t, remote);
}
