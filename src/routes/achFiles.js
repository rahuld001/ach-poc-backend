import { Router } from 'express';
import { query } from '../db.js';
import { runBatch } from '../services/batcher.js';
import { HttpError } from '../services/transfers.js';

const router = Router();

const SUMMARY = `id, file_id_modifier, batch_count, entry_count, total_debit_cents, total_credit_cents,
                 status, process_after, processed_at, bank_response, created_at`;

router.get('/', async (_req, res) => {
  const { rows } = await query(`SELECT ${SUMMARY} FROM ach_files ORDER BY created_at DESC LIMIT 100`);
  res.json(rows);
});

router.post('/run', async (_req, res) => {
  const file = await runBatch();
  res.json(file ? { file } : { file: null, message: 'No pending transfers to batch' });
});

router.get('/:id', async (req, res) => {
  const { rows: [file] } = await query(`SELECT ${SUMMARY}, content FROM ach_files WHERE id = $1`, [req.params.id]);
  if (!file) throw new HttpError(404, 'ACH file not found');
  res.json(file);
});

router.get('/:id/download', async (req, res) => {
  const { rows: [file] } = await query('SELECT content, created_at, file_id_modifier FROM ach_files WHERE id = $1', [req.params.id]);
  if (!file) throw new HttpError(404, 'ACH file not found');
  const stamp = new Date(file.created_at).toISOString().slice(0, 10);
  res.type('text/plain').attachment(`ach-${stamp}-${file.file_id_modifier}.txt`).send(file.content);
});

export default router;
