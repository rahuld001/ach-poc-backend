import crypto from 'node:crypto';
import { Router } from 'express';
import { query, withTx } from '../db.js';
import { encrypt } from '../crypto.js';
import { isValidRoutingNumber } from '../ach.js';
import { createLinkToken, exchangeAndGetAuth, plaidEnabled } from '../plaid.js';
import { HttpError } from '../services/transfers.js';

const router = Router();

const PUBLIC_COLUMNS = `id, holder_name, institution_name, routing_number, last4, account_type,
                        source, status, disabled_reason, created_at`;

router.get('/', async (_req, res) => {
  const { rows } = await query(`SELECT ${PUBLIC_COLUMNS} FROM bank_accounts ORDER BY created_at DESC`);
  res.json(rows);
});

// Manual entry: validated, then verified with simulated micro-deposits.
router.post('/', async (req, res) => {
  const { holder_name, routing_number, account_number, account_type = 'checking' } = req.body ?? {};
  if (!holder_name?.trim()) throw new HttpError(400, 'holder_name is required');
  if (!isValidRoutingNumber(String(routing_number ?? ''))) throw new HttpError(400, 'Invalid routing number');
  if (!/^\d{4,17}$/.test(String(account_number ?? ''))) throw new HttpError(400, 'Account number must be 4-17 digits');
  if (!['checking', 'savings'].includes(account_type)) throw new HttpError(400, 'account_type must be checking or savings');

  const amounts = [crypto.randomInt(1, 100), crypto.randomInt(1, 100)];
  const account = await withTx(async (client) => {
    const { rows: [row] } = await client.query(
      `INSERT INTO bank_accounts (holder_name, routing_number, account_number_enc, last4, account_type, source, status)
       VALUES ($1, $2, $3, $4, $5, 'manual', 'pending_verification')
       RETURNING ${PUBLIC_COLUMNS}`,
      [holder_name.trim(), routing_number, encrypt(account_number), String(account_number).slice(-4), account_type],
    );
    await client.query(
      `INSERT INTO micro_deposits (bank_account_id, amount1_cents, amount2_cents, expires_at)
       VALUES ($1, $2, $3, now() + interval '7 days')`,
      [row.id, ...amounts],
    );
    return row;
  });

  // Test mode only: a real system would never reveal these; the customer reads them off their statement.
  res.status(201).json({ ...account, sandbox_micro_deposits_cents: amounts });
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
    `UPDATE bank_accounts SET status = 'disabled', disabled_reason = 'Removed by user' WHERE id = $1`,
    [req.params.id],
  );
  if (!rowCount) throw new HttpError(404, 'Account not found');
  res.status(204).end();
});

// --- Plaid sandbox (instant account verification) ---

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
      const { rows } = await client.query(
        `INSERT INTO bank_accounts (holder_name, institution_name, routing_number, account_number_enc, last4,
                                    account_type, source, plaid_item_id, plaid_account_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'plaid', $7, $8, 'verified')
         ON CONFLICT (plaid_account_id) DO NOTHING
         RETURNING ${PUBLIC_COLUMNS}`,
        [holder_name?.trim() || a.name || 'Plaid Account Holder', institution_name ?? null, a.routing,
         encrypt(a.account), a.account.slice(-4), a.type, item.id, a.plaidAccountId],
      );
      out.push(...rows);
    }
    return out;
  });
  res.status(201).json(saved);
});

export default router;
