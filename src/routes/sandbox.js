// Test-mode only endpoints for driving the simulation from the UI.
import { Router } from 'express';
import { query, withTx } from '../db.js';
import { RETURN_CODES } from '../ach.js';
import { processDueFiles } from '../services/mockBank.js';
import { HttpError, returnTransfer, setTransferStatus } from '../services/transfers.js';
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

router.post('/transfers/:id/settle', async (req, res) => {
  if (await viaIncrease(req.params.id, 'settle')) return res.json({ ok: true });
  await withTx(async (client) => {
    const t = await lockTransfer(client, req.params.id);
    if (t.status !== 'submitted') throw new HttpError(409, `Only submitted transfers can be settled (status: ${t.status})`);
    await setTransferStatus(client, t.id, 'settled', 'Settled (sandbox simulation)');
  });
  res.json({ ok: true });
});

// Submitted or already-settled transfers can be returned (late returns such as R10 come after settlement).
router.post('/transfers/:id/return', async (req, res) => {
  const code = req.body?.return_code;
  if (!RETURN_CODES[code]) throw new HttpError(400, 'Unknown return_code');
  if (await viaIncrease(req.params.id, 'return', code)) return res.json({ ok: true });
  await withTx(async (client) => {
    const t = await lockTransfer(client, req.params.id);
    if (!['submitted', 'settled'].includes(t.status)) {
      throw new HttpError(409, `Only submitted or settled transfers can be returned (status: ${t.status})`);
    }
    await returnTransfer(client, t, code, 'sandbox simulation');
  });
  res.json({ ok: true });
});

router.post('/process-bank', async (_req, res) => {
  const processed = await processDueFiles({ force: true });
  res.json({ processed_files: processed });
});

export default router;
