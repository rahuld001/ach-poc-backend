// Test-mode only endpoints for driving the simulation from the UI. They do not exist in live mode.
import { Router } from 'express';
import { query, withTx } from '../db.js';
import { RETURN_CODES } from '../ach.js';
import { runOdfiJobs, settleTransfer } from '../services/odfi/index.js';
import { simulateReturn } from '../services/odfi/mock.js';
import { HttpError } from '../services/transfers.js';
import { post } from '../services/ledger.js';
import { simulateOnIncrease } from '../services/increase.js';

const router = Router();

async function lockTransfer(client, id) {
  const { rows: [t] } = await client.query('SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [id]);
  if (!t) throw new HttpError(404, 'Transfer not found');
  return t;
}

// Increase-rail transfers are simulated at Increase, then their new state is synced back.
async function viaIncrease(id, action, code) {
  const { rows: [t] } = await query('SELECT * FROM transfers WHERE id = $1', [id]);
  if (t?.rail !== 'increase') return false;
  if (!t.provider_transfer_id) throw new HttpError(409, 'Transfer has not been sent to Increase yet (run a batch first)');
  await simulateOnIncrease(t, action, code);
  return true;
}

// Jump to the effective date for one entry.
router.post('/transfers/:id/settle', async (req, res) => {
  if (await viaIncrease(req.params.id, 'settle')) return res.json({ ok: true });
  await withTx(async (client) => {
    const t = await lockTransfer(client, req.params.id);
    if (!['submitted', 'accepted'].includes(t.status)) throw new HttpError(409, `Only submitted or accepted transfers can be settled (status: ${t.status})`);
    await settleTransfer(client, t, 'Settled (simulation: effective date reached)');
  });
  res.json({ ok: true });
});

// The receiving bank returns the entry: a real NACHA return file is produced and processed, exactly like the
// bank's own returns. Settled entries can be returned too (late returns such as R10 come after settlement).
router.post('/transfers/:id/return', async (req, res) => {
  const code = req.body?.return_code;
  if (!RETURN_CODES[code]) throw new HttpError(400, 'Unknown return_code');
  if (await viaIncrease(req.params.id, 'return', code)) return res.json({ ok: true });
  const { rows: [t] } = await query('SELECT * FROM transfers WHERE id = $1', [req.params.id]);
  if (!t) throw new HttpError(404, 'Transfer not found');
  if (!['submitted', 'accepted', 'settled'].includes(t.status)) {
    throw new HttpError(409, `Only submitted, accepted or settled transfers can be returned (status: ${t.status})`);
  }
  const result = await simulateReturn(t, code);
  res.json({ ok: true, file: result.file, results: result.results });
});

// Put simulated money on the operating account (in real life: a wire or ACH credit from the business's own bank).
router.post('/fund', async (req, res) => {
  const cents = Number(req.body?.amount_cents);
  if (!Number.isInteger(cents) || cents <= 0 || cents > 100_000_000) throw new HttpError(400, 'amount_cents must be a positive integer up to $1,000,000');
  const acct = await withTx((client) => post(client, { type: 'funding', amountCents: cents, note: 'Simulated funding (sandbox)' }));
  res.json({ balance_cents: Number(acct.balance_cents), held_cents: Number(acct.held_cents) });
});

// Advance the simulated bank clock: acknowledge, settle and return everything that is in flight, right now.
router.post('/process-bank', async (_req, res) => {
  res.json(await runOdfiJobs({ force: true }));
});

export default router;
