import { Router } from 'express';
import { query, withTx } from '../db.js';
import {
  ADMINISTRATIVE_RETURN_CODES, RETURN_RATE_THRESHOLDS, REVERSAL_WINDOW_BANKING_DAYS, UNAUTHORIZED_RETURN_CODES,
  addBankingDays, authorizationText, secCodeFor, toIsoDate,
} from '../ach.js';
import { HttpError, setTransferStatus } from '../services/transfers.js';
import { holdForTransfer } from '../services/ledger.js';
import { increaseEnabled } from '../services/increase.js';
import { checkPayment } from '../services/verification.js';

const router = Router();

const LIST_SQL = `
  SELECT t.id, t.direction, t.amount_cents, t.description, t.sec_code, t.status, t.trace_number,
         t.ach_file_id, t.effective_date, t.return_code, t.return_reason, t.created_at, t.updated_at,
         t.rail, t.provider_transfer_id, t.risk, t.purpose, t.reverses_transfer_id, t.reversed_by_transfer_id,
         t.settled_at, t.return_window_ends,
         a.id AS bank_account_id, a.holder_name, a.institution_name, a.last4, a.account_type,
         f.file_name
    FROM transfers t JOIN bank_accounts a ON a.id = t.bank_account_id
    LEFT JOIN ach_files f ON f.id = t.ach_file_id`;

router.get('/', async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.status) {
    params.push(req.query.status);
    where.push(`t.status = $${params.length}`);
  }
  if (req.query.purpose) {
    params.push(req.query.purpose);
    where.push(`t.purpose = $${params.length}`);
  }
  const { rows } = await query(`${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.created_at DESC LIMIT 200`, params);
  res.json(rows);
});

// Nacha return-rate monitoring: debit entries from the last 60 days against the thresholds an originator must stay
// under (unauthorized 0.5%, administrative 3%, overall 15%). Breaching one triggers an ODFI inquiry.
router.get('/return-rates', async (_req, res) => {
  const { rows: [r] } = await query(
    `SELECT count(*)::int AS originated,
            count(*) FILTER (WHERE status = 'returned')::int AS returned,
            count(*) FILTER (WHERE return_code = ANY($1))::int AS unauthorized,
            count(*) FILTER (WHERE return_code = ANY($2))::int AS administrative
       FROM transfers
      WHERE direction = 'debit' AND purpose = 'payment' AND status IN ('submitted', 'accepted', 'settled', 'returned')
        AND created_at > now() - interval '60 days'`,
    [UNAUTHORIZED_RETURN_CODES, ADMINISTRATIVE_RETURN_CODES],
  );
  const rate = (n) => (r.originated ? n / r.originated : 0);
  const rates = { unauthorized: rate(r.unauthorized), administrative: rate(r.administrative), overall: rate(r.returned) };
  res.json({
    window_days: 60,
    debits_originated: r.originated,
    counts: { returned: r.returned, unauthorized: r.unauthorized, administrative: r.administrative },
    rates,
    thresholds: RETURN_RATE_THRESHOLDS,
    breaches: Object.keys(rates).filter((k) => rates[k] > RETURN_RATE_THRESHOLDS[k]),
  });
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
  const { bank_account_id, direction, amount_cents, description, authorization, rail = 'mock' } = req.body ?? {};
  const idempotencyKey = req.get('Idempotency-Key') || null;

  if (idempotencyKey) {
    const { rows: [existing] } = await query(`${LIST_SQL} WHERE t.idempotency_key = $1`, [idempotencyKey]);
    if (existing) {
      // Same key with a different payment is a client bug, not a retry: refuse rather than return the wrong transfer.
      const same = existing.bank_account_id === bank_account_id && existing.direction === direction &&
        existing.amount_cents === amount_cents && existing.rail === rail;
      if (!same) throw new HttpError(422, 'Idempotency-Key was already used for a different payment');
      return res.json(existing);
    }
  }

  if (!['debit', 'credit'].includes(direction)) throw new HttpError(400, 'direction must be debit or credit');
  if (!['mock', 'increase'].includes(rail)) throw new HttpError(400, 'rail must be mock or increase');
  if (rail === 'increase' && !increaseEnabled) throw new HttpError(400, 'The Increase rail is not configured (set INCREASE_API_KEY)');
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) throw new HttpError(400, 'amount_cents must be a positive integer');
  const max = Number(process.env.MAX_TRANSFER_CENTS ?? 1_000_000);
  if (amount_cents > max) throw new HttpError(400, `Amount exceeds per-transfer limit of $${(max / 100).toFixed(2)}`);
  if (authorization?.accepted !== true) throw new HttpError(400, 'Customer authorization is required');

  const created = await withTx(async (client) => {
    const { rows: [account] } = await client.query('SELECT * FROM bank_accounts WHERE id = $1 FOR UPDATE', [bank_account_id]);
    if (!account) throw new HttpError(404, 'Bank account not found');
    if (account.status !== 'verified') throw new HttpError(409, `Bank account is ${account.status}`);

    const daily = Number(process.env.DAILY_LIMIT_CENTS ?? 2_500_000);
    const { rows: [{ total }] } = await client.query(
      `SELECT coalesce(sum(amount_cents), 0)::bigint AS total FROM transfers
        WHERE bank_account_id = $1 AND purpose = 'payment' AND created_at::date = current_date
          AND status NOT IN ('cancelled', 'failed', 'returned')`,
      [bank_account_id],
    );
    if (total + amount_cents > daily) throw new HttpError(400, `Daily limit of ${(daily / 100).toFixed(2)} exceeded for this account`);

    // Pre-payment checks (simulated): sanctions, account validation, identity, balance, duplicates, velocity.
    const risk = await checkPayment(client, { account, direction, amount_cents });
    if (risk.decision === 'block') {
      throw new HttpError(422, `Payment blocked: ${risk.checks.find((c) => c.level === 'fail').label}`, { risk });
    }

    // The server writes the mandate wording (the same text the UI showed, from the /api/config templates), so a
    // client cannot record words the customer never saw. req.ip is the real client: see trust proxy in index.js.
    const { rows: [mandate] } = await client.query(
      `INSERT INTO mandates (bank_account_id, authorization_text, ip_address, user_agent)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [bank_account_id, authorizationText(direction, amount_cents, account.last4), req.ip, req.get('User-Agent') ?? null],
    );
    // A payout is paid from the operating account: reserve the (simulated) money now, or refuse the payment.
    await holdForTransfer(client, { direction, amount_cents });
    const { rows: [t] } = await client.query(
      `INSERT INTO transfers (bank_account_id, mandate_id, direction, amount_cents, description, sec_code, status, idempotency_key, rail, risk, purpose)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, 'payment') RETURNING id`,
      [bank_account_id, mandate.id, direction, amount_cents, description ?? null, secCodeFor(direction), idempotencyKey, rail, risk],
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

// Reversal: an erroneous or duplicate entry is undone with an opposite entry in the same SEC code, entry description
// REVERSAL, sent within 5 banking days of settlement. No new customer authorization is needed.
router.post('/:id/reverse', async (req, res) => {
  const created = await withTx(async (client) => {
    const { rows: [t] } = await client.query('SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!t) throw new HttpError(404, 'Transfer not found');
    if (t.rail !== 'mock') throw new HttpError(400, 'Reversals are only implemented for the direct ACH rail');
    if (t.purpose !== 'payment') throw new HttpError(409, 'Only customer payments can be reversed');
    if (t.status !== 'settled') throw new HttpError(409, `Only settled transfers can be reversed (status: ${t.status})`);
    if (t.reversed_by_transfer_id) throw new HttpError(409, 'This transfer has already been reversed');
    const deadline = toIsoDate(addBankingDays(new Date(t.settled_at), REVERSAL_WINDOW_BANKING_DAYS));
    if (toIsoDate(new Date()) > deadline) throw new HttpError(409, `The 5 banking day reversal window closed on ${deadline}`);

    await holdForTransfer(client, { direction: t.direction === 'debit' ? 'credit' : 'debit', amount_cents: t.amount_cents });
    const { rows: [r] } = await client.query(
      `INSERT INTO transfers (bank_account_id, mandate_id, direction, amount_cents, description, sec_code, status, rail, purpose, reverses_transfer_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'mock', 'reversal', $7) RETURNING id`,
      [t.bank_account_id, t.mandate_id, t.direction === 'debit' ? 'credit' : 'debit', t.amount_cents,
       `REVERSAL of ${t.description || t.trace_number}`, t.sec_code, t.id],
    );
    await client.query(`INSERT INTO transfer_events (transfer_id, status, note) VALUES ($1, 'pending', $2)`, [
      r.id,
      `Reversal of trace ${t.trace_number} (${req.body?.reason || 'erroneous entry'})`,
    ]);
    await client.query('UPDATE transfers SET reversed_by_transfer_id = $2, updated_at = now() WHERE id = $1', [t.id, r.id]);
    await client.query(`INSERT INTO transfer_events (transfer_id, status, note) VALUES ($1, $2, $3)`, [
      t.id,
      t.status,
      `Reversal requested (${req.body?.reason || 'erroneous entry'}); reversing entry goes out with the next file`,
    ]);
    return r;
  });
  const { rows: [transfer] } = await query(`${LIST_SQL} WHERE t.id = $1`, [created.id]);
  res.status(201).json(transfer);
});

export default router;
