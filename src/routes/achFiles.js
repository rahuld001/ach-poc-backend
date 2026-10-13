import { Router } from 'express';
import { query } from '../db.js';
import { runBatch } from '../services/batcher.js';
import { sendPendingToIncrease } from '../services/increase.js';
import { applyInboundFile } from '../services/inbound.js';
import { HttpError } from '../services/transfers.js';
import { decryptIfEncrypted } from '../crypto.js';
import { maskAccountNumbers } from '../nacha.js';

const router = Router();

const SUMMARY = `id, kind, file_name, transport, file_id_modifier, batch_count, entry_count, total_debit_cents, total_credit_cents,
                 status, effective_date, process_after, acknowledged_at, settles_at, processed_at, bank_response, created_at`;

router.get('/', async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.kind) {
    params.push(req.query.kind);
    where = 'WHERE kind = $1';
  }
  const { rows } = await query(`SELECT ${SUMMARY} FROM ach_files ${where} ORDER BY created_at DESC LIMIT 100`, params);
  res.json(rows);
});

router.post('/run', async (_req, res) => {
  const file = await runBatch();
  const increaseSent = await sendPendingToIncrease();
  res.json({ file, increase_sent: increaseSent, ...(!file && !increaseSent && { message: 'No pending transfers to batch' }) });
});

// A return / NOC file received from the ODFI by other means (bank portal download, email) can be applied here.
router.post('/inbound', async (req, res) => {
  const { content, file_name } = req.body ?? {};
  if (typeof content !== 'string' || !content.trim()) throw new HttpError(400, 'content (the NACHA file text) is required');
  const result = await applyInboundFile(content, { transport: 'upload', fileName: file_name?.trim() || `upload-${Date.now()}.ach` });
  if (result.errors.length) throw new HttpError(400, `File rejected: ${result.errors[0]}`, { errors: result.errors, file: result.file });
  res.status(201).json(result);
});

router.get('/:id', async (req, res) => {
  const { rows: [file] } = await query(`SELECT ${SUMMARY}, content FROM ach_files WHERE id = $1`, [req.params.id]);
  if (!file) throw new HttpError(404, 'ACH file not found');
  // For display: account numbers masked to their last 4. Only the download carries the file as exchanged with the bank.
  res.json({ ...file, content: maskAccountNumbers(decryptIfEncrypted(file.content)) });
});

router.get('/:id/download', async (req, res) => {
  const { rows: [file] } = await query('SELECT content, created_at, file_id_modifier, file_name FROM ach_files WHERE id = $1', [req.params.id]);
  if (!file) throw new HttpError(404, 'ACH file not found');
  const stamp = new Date(file.created_at).toISOString().slice(0, 10);
  res.type('text/plain').attachment(file.file_name || `ach-${stamp}-${file.file_id_modifier}.txt`).send(decryptIfEncrypted(file.content));
});

export default router;
