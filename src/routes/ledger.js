// The simulated operating account: balance, held payouts and the money movements behind every transfer.
import { Router } from 'express';
import { summary } from '../services/ledger.js';

const router = Router();

router.get('/', async (_req, res) => {
  res.json(await summary());
});

export default router;
