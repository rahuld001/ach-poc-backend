import crypto from 'node:crypto';
import { Router } from 'express';
import { query, withTx } from '../db.js';
import { encrypt } from '../crypto.js';
import { authorizationText, isValidRoutingNumber } from '../ach.js';
import { createLinkToken, exchangeAndGetAuth, plaidEnabled } from '../plaid.js';
import { HttpError } from '../services/transfers.js';
import { verifyCustomer, verifyPlaidCustomer } from '../services/verification.js';
import { holdForTransfer } from '../services/ledger.js';
import { isTestMode } from '../config.js';

const router = Router();

const PUBLIC_COLUMNS = `id, holder_name, institution_name, routing_number, last4, account_type,
                        source, status, disabled_reason, kyc, created_at`;

// Micro-deposit entries and notifications of change applied to the account, for the account card.
const LIST_SQL = `
  SELECT ${PUBLIC_COLUMNS},
         (SELECT json_agg(json_build_object('id', t.id, 'direction', t.direction, 'amount_cents', t.amount_cents,
                                            'status', t.status, 'trace_number', t.trace_number,
                                            'effective_date', t.effective_date, 'return_code', t.return_code)
                          ORDER BY t.direction DESC, t.created_at)
            FROM transfers t WHERE t.bank_account_id = a.id AND t.purpose = 'micro_deposit') AS micro_deposits,
         (SELECT json_agg(json_build_object('change_code', c.change_code, 'description', c.description,
                                            'old_value', c.old_value, 'new_value', c.new_value, 'created_at', c.created_at)
                          ORDER BY c.id)
            FROM account_changes c WHERE c.bank_account_id = a.id) AS changes
    FROM bank_accounts a`;

/** Where the verification micro-deposits are, and (test mode only) the amounts to type in. */
function present(row) {
  const deposits = row.micro_deposits ?? [];
  const credits = deposits.filter((d) => d.direction === 'credit');
  let state = null;
  if (credits.length) {
    if (credits.some((d) => ['returned', 'failed'].includes(d.status))) state = 'returned';
    else if (credits.every((d) => d.status === 'settled')) state = 'settled';
    else if (credits.every((d) => d.status === 'pending')) state = 'pending';
    else state = 'in_transit';
  }
  return {
    ...row,
    micro_deposits: deposits.map((d) => ({ ...d, amount_cents: isTestMode ? d.amount_cents : null })),
    verification: credits.length ? { state, amounts_cents: isTestMode ? credits.map((d) => d.amount_cents) : null } : null,
  };
}

router.get('/', async (_req, res) => {
  const { rows } = await query(`${LIST_SQL} ORDER BY a.created_at DESC`);
  res.json(rows.map(present));
});

// Manual entry (direct ACH): identity checks, then two micro-deposit credits and one offsetting debit are originated
// through the ODFI like any other entry. The customer verifies the amounts once the credits have settled.
router.post('/', async (req, res) => {
  const { holder_name, routing_number, account_number, account_type = 'checking', dob, ssn_last4, address, authorization } = req.body ?? {};
  if (!holder_name?.trim()) throw new HttpError(400, 'holder_name is required');
  if (!isValidRoutingNumber(String(routing_number ?? ''))) throw new HttpError(400, 'Invalid routing number');
  if (!/^\d{4,17}$/.test(String(account_number ?? ''))) throw new HttpError(400, 'Account number must be 4-17 digits');
  if (!['checking', 'savings'].includes(account_type)) throw new HttpError(400, 'account_type must be checking or savings');
  if (ssn_last4 && !/^\d{4}$/.test(String(ssn_last4))) throw new HttpError(400, 'SSN last 4 must be 4 digits');
  if (authorization?.accepted !== true) throw new HttpError(400, 'Authorization for the verification micro-deposits is required');

  const last4 = String(account_number).slice(-4);
  // Identity, sanctions and account-status checks (simulated). A failure stops the account from being linked.
  const kyc = verifyCustomer({ holder_name, dob, ssn_last4, address, last4 });
  if (kyc.result === 'fail') {
    throw new HttpError(422, `Verification failed: ${kyc.checks.find((c) => c.level === 'fail').label}`, { kyc });
  }

  const amounts = [crypto.randomInt(1, 100), crypto.randomInt(1, 100)];
  const account = await withTx(async (client) => {
    const { rows: [row] } = await client.query(
      `INSERT INTO bank_accounts (holder_name, routing_number, account_number_enc, last4, account_type, source, status, kyc)
       VALUES ($1, $2, $3, $4, $5, 'manual', 'pending_verification', $6)
       RETURNING ${PUBLIC_COLUMNS}`,
      [holder_name.trim(), routing_number, encrypt(account_number), last4, account_type, kyc],
    );
    await client.query(
      `INSERT INTO micro_deposits (bank_account_id, amount1_cents, amount2_cents, expires_at)
       VALUES ($1, $2, $3, now() + interval '7 days')`,
      [row.id, ...amounts],
    );
    // The customer authorizes the verification entries; that mandate covers all three.
    const { rows: [mandate] } = await client.query(
      `INSERT INTO mandates (bank_account_id, authorization_text, ip_address, user_agent) VALUES ($1, $2, $3, $4) RETURNING id`,
      [row.id, authorizationText('verification', 0, last4), req.ip, req.get('User-Agent') ?? null],
    );
    const entries = [
      ['credit', amounts[0]],
      ['credit', amounts[1]],
      ['debit', amounts[0] + amounts[1]],
    ];
    for (const [direction, cents] of entries) {
      await holdForTransfer(client, { direction, amount_cents: cents }); // the two credits are paid from the operating account
      const { rows: [t] } = await client.query(
        `INSERT INTO transfers (bank_account_id, mandate_id, direction, amount_cents, description, sec_code, status, rail, purpose)
         VALUES ($1, $2, $3, $4, 'Account verification', 'PPD', 'pending', 'mock', 'micro_deposit') RETURNING id`,
        [row.id, mandate.id, direction, cents],
      );
      await client.query(`INSERT INTO transfer_events (transfer_id, status, note) VALUES ($1, 'pending', 'Verification micro-deposit created')`, [t.id]);
    }
    return row;
  });

  // Test mode only: a real system never reveals these; the customer reads them off their bank statement.
  res.status(201).json({ ...account, ...(isTestMode && { sandbox_micro_deposits_cents: amounts }) });
});

router.post('/:id/verify', async (req, res) => {
  const [a, b] = (req.body?.amounts_cents ?? []).map(Number);
  const result = await withTx(async (client) => {
    const { rows: [md] } = await client.query(
      `SELECT m.*, a.status FROM micro_deposits m JOIN bank_accounts a ON a.id = m.bank_account_id
        WHERE m.bank_account_id = $1 FOR UPDATE OF m`,
      [req.params.id],
    );
    if (!md) throw new HttpError(404, 'No micro-deposits found for this account');
    if (md.status !== 'pending_verification') throw new HttpError(409, `Account is ${md.status}`);
    if (new Date(md.expires_at) < new Date()) throw new HttpError(410, 'Micro-deposits expired');

    // The customer can only have seen the amounts once the credits settled at their bank.
    const { rows: credits } = await client.query(
      `SELECT status FROM transfers WHERE bank_account_id = $1 AND purpose = 'micro_deposit' AND direction = 'credit'`,
      [req.params.id],
    );
    if (credits.length && !credits.every((c) => c.status === 'settled')) {
      throw new HttpError(409, 'The micro-deposits have not reached the account yet (they settle on the next banking day)');
    }

    const expected = [md.amount1_cents, md.amount2_cents].sort((x, y) => x - y).join();
    if ([a, b].sort((x, y) => x - y).join() === expected) {
      await client.query(`UPDATE bank_accounts SET status = 'verified' WHERE id = $1`, [req.params.id]);
      return { verified: true };
    }
    const attempts = md.attempts + 1;
    await client.query('UPDATE micro_deposits SET attempts = $2 WHERE bank_account_id = $1', [req.params.id, attempts]);
    if (attempts >= 3) {
      await client.query(
        `UPDATE bank_accounts SET status = 'disabled', disabled_reason = 'Too many failed verification attempts' WHERE id = $1`,
        [req.params.id],
      );
    }
    return { verified: false, attempts_remaining: Math.max(0, 3 - attempts) };
  });
  res.json(result);
});

router.delete('/:id', async (req, res) => {
  const { rowCount } = await query(
    `UPDATE bank_accounts SET status = 'disabled', disabled_reason = 'Removed by user' WHERE id = $1 AND status <> 'disabled'`,
    [req.params.id],
  );
  if (!rowCount) throw new HttpError(404, 'Account not found or already disabled');
  res.status(204).end();
});

// --- Plaid (instant account verification; optional, not part of the direct ACH path) ---

router.post('/plaid/link-token', async (_req, res) => {
  if (!plaidEnabled) throw new HttpError(400, 'Plaid is not configured (set PLAID_CLIENT_ID / PLAID_SECRET)');
  res.json({ link_token: await createLinkToken('demo-user') });
});

router.post('/plaid/exchange', async (req, res) => {
  if (!plaidEnabled) throw new HttpError(400, 'Plaid is not configured');
  const { public_token, institution_name, holder_name } = req.body ?? {};
  if (!public_token) throw new HttpError(400, 'public_token is required');

  const { itemId, accessToken, accounts } = await exchangeAndGetAuth(public_token);
  const saved = await withTx(async (client) => {
    const { rows: [item] } = await client.query(
      `INSERT INTO plaid_items (item_id, access_token_enc, institution_name) VALUES ($1, $2, $3)
       ON CONFLICT (item_id) DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc
       RETURNING id`,
      [itemId, encrypt(accessToken), institution_name ?? null],
    );
    const out = [];
    for (const a of accounts) {
      // The owner name as the bank holds it (Plaid Identity) beats what the customer typed. The account's own label
      // ("Plaid Checking") is never a person's name, so it is not used.
      const holder = a.ownerName
        ? { name: a.ownerName, source: 'bank' }
        : holder_name?.trim() ? { name: holder_name.trim(), source: 'customer' } : null;
      if (!holder) {
        throw new HttpError(400, 'The bank did not return the account owner name. Enter the account holder name and link again.', {
          needs_holder_name: true,
        });
      }
      const { rows } = await client.query(
        `INSERT INTO bank_accounts (holder_name, institution_name, routing_number, account_number_enc, last4,
                                    account_type, source, plaid_item_id, plaid_account_id, status, kyc)
         VALUES ($1, $2, $3, $4, $5, $6, 'plaid', $7, $8, 'verified', $9)
         ON CONFLICT (plaid_account_id) DO NOTHING
         RETURNING ${PUBLIC_COLUMNS}`,
        [holder.name, institution_name ?? null, a.routing,
         encrypt(a.account), a.account.slice(-4), a.type, item.id, a.plaidAccountId,
         verifyPlaidCustomer(holder.name, holder.source)],
      );
      out.push(...rows);
    }
    return out;
  });
  res.status(201).json(saved);
});

export default router;
