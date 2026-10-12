import { Router } from 'express';
import { query, withTx } from '../db.js';
import { secCodeFor } from '../ach.js';
import { HttpError, setTransferStatus } from '../services/transfers.js';

const router = Router();

const LIST_SQL = `
  SELECT t.id, t.direction, t.amount_cents, t.description, t.sec_code, t.status, t.trace_number,
         t.ach_file_id, t.effective_date, t.return_code, t.return_reason, t.created_at, t.updated_at,
         a.id AS bank_account_id, a.holder_name, a.institution_name, a.last4, a.account_type
    FROM transfers t JOIN bank_accounts a ON a.id = t.bank_account_id`;

router.get('/', async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.status) {
    params.push(req.query.status);
    where = 'WHERE t.status = $1';
  }
  const { rows } = await query(`${LIST_SQL} ${where} ORDER BY t.created_at DESC LIMIT 200`, params);
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows: [transfer] } = await query(`${LIST_SQL} WHERE t.id = $1`, [req.params.id]);
  if (!transfer) throw new HttpError(404, 'Transfer not found');
  const { rows: events } = await query(
    'SELECT status, note, created_at FROM transfer_events WHERE transfer_id = $1 ORDER BY id',
    [req.params.id],
  );
  res.json({ ...transfer, events });
});

router.post('/', async (req, res) => {
  const { bank_account_id, direction, amount_cents, description, authorization } = req.body ?? {};
  const idempotencyKey = req.get('Idempotency-Key') || null;

  if (idempotencyKey) {
    const { rows: [existing] } = await query(`${LIST_SQL} WHERE t.idempotency_key = $1`, [idempotencyKey]);
    if (existing) return res.json(existing);
  }

  if (!['debit', 'credit'].includes(direction)) throw new HttpError(400, 'direction must be debit or credit');
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) throw new HttpError(400, 'amount_cents must be a positive integer');
  const max = Number(process.env.MAX_TRANSFER_CENTS ?? 1_000_000);
  if (amount_cents > max) throw new HttpError(400, `Amount exceeds per-transfer limit of $${(max / 100).toFixed(2)}`);
  if (!authorization?.accepted || !authorization?.text) throw new HttpError(400, 'Customer authorization is required');

  const created = await withTx(async (client) => {
    const { rows: [account] } = await client.query('SELECT * FROM bank_accounts WHERE id = $1 FOR UPDATE', [bank_account_id]);
    if (!account) throw new HttpError(404, 'Bank account not found');
    if (account.status !== 'verified') throw new HttpError(409, `Bank account is ${account.status}`);

    const daily = Number(process.env.DAILY_LIMIT_CENTS ?? 2_500_000);
    const { rows: [{ total }] } = await client.query(
      `SELECT coalesce(sum(amount_cents), 0)::bigint AS total FROM transfers
        WHERE bank_account_id = $1 AND created_at::date = current_date
          AND status NOT IN ('cancelled', 'failed', 'returned')`,
      [bank_account_id],
    );
    if (total + amount_cents > daily) throw new HttpError(400, `Daily limit of $${(daily / 100).toFixed(2)} exceeded for this account`);

    const { rows: [mandate] } = await client.query(
      `INSERT INTO mandates (bank_account_id, authorization_text, ip_address, user_agent)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [bank_account_id, authorization.text, req.ip, req.get('User-Agent') ?? null],
    );
    const { rows: [t] } = await client.query(
      `INSERT INTO transfers (bank_account_id, mandate_id, direction, amount_cents, description, sec_code, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7) RETURNING id`,
      [bank_account_id, mandate.id, direction, amount_cents, description ?? null, secCodeFor(direction), idempotencyKey],
    );
    await client.query(`INSERT INTO transfer_events (transfer_id, status, note) VALUES ($1, 'pending', 'Transfer created')`, [t.id]);
    return t;
  });

  const { rows: [transfer] } = await query(`${LIST_SQL} WHERE t.id = $1`, [created.id]);
  res.status(201).json(transfer);
});

router.post('/:id/cancel', async (req, res) => {
  await withTx(async (client) => {
    const { rows: [t] } = await client.query('SELECT status FROM transfers WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!t) throw new HttpError(404, 'Transfer not found');
    if (t.status !== 'pending') throw new HttpError(409, `Only pending transfers can be cancelled (status: ${t.status})`);
    await setTransferStatus(client, req.params.id, 'cancelled', 'Cancelled by user');
  });
  res.json({ cancelled: true });
});

export default router;
