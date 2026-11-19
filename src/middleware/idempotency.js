// Durable idempotency for payment initiation.
//
// Usage in a route:
//   const result = await withIdempotency(client, {
//     idempotencyKey, requestPath, payloadHash,
//   });
//   if (result.cached) return res.status(result.cachedStatus).json(result.cachedBody);
//   // ... create the resource ...
//   await saveIdempotencyResponse(client, { idempotencyKey, status: 201, body: created });
//
// The INSERT uses ON CONFLICT DO NOTHING so two concurrent requests with the same key will
// serialize at the unique-constraint level: the second INSERT blocks until the first
// transaction commits or rolls back, then finds the row and returns the cached response.

import crypto from 'node:crypto';

/**
 * Computes a canonical SHA-256 payload hash for transfer idempotency comparison.
 * Only the fields that identify the payment are included; metadata fields (description,
 * user-agent, etc.) are excluded so a retry with the same payment but a different
 * description is still recognized as the same payment.
 */
export function computePayloadHash(fields) {
  // Sort keys so field ordering differences do not produce different hashes.
  const canonical = JSON.stringify(
    Object.fromEntries(Object.keys(fields).sort().map((k) => [k, fields[k]])),
  );
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Atomically checks the idempotency_records table and either claims the key (new request)
 * or returns whether the key was already used with the same or a different payload.
 *
 * Must be called inside an active database transaction (client).
 *
 * Returns:
 *   { isNew: true }                              — key was just claimed; proceed normally
 *   { isNew: false, conflict: true }             — key already used with a DIFFERENT payload; return 409
 *   { isNew: false, conflict: false, status, body } — key already used with same payload; replay response
 *   { isNew: false, conflict: false, inFlight: true } — same payload but response not yet stored (concurrent); retry
 */
export async function checkIdempotency(client, { idempotencyKey, requestPath, payloadHash }) {
  // Attempt to claim the key. ON CONFLICT DO NOTHING lets us detect whether we inserted.
  const { rowCount } = await client.query(
    `INSERT INTO idempotency_records (idempotency_key, request_path, payload_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [idempotencyKey, requestPath, payloadHash],
  );

  if (rowCount === 1) {
    // We inserted it — this is a new request.
    return { isNew: true };
  }

  // Key already existed — fetch the stored record.
  const { rows: [rec] } = await client.query(
    'SELECT payload_hash, response_status, response_body FROM idempotency_records WHERE idempotency_key = $1',
    [idempotencyKey],
  );

  if (!rec || rec.payload_hash !== payloadHash) {
    // Different payload — the client reused a key for a different payment. This is a client bug.
    return { isNew: false, conflict: true };
  }

  if (rec.response_body === null) {
    // Same payload but no response stored yet — a concurrent request is still processing.
    return { isNew: false, conflict: false, inFlight: true };
  }

  // Same payload, response already stored — safe to replay.
  return { isNew: false, conflict: false, status: rec.response_status, body: rec.response_body };
}

/**
 * Stores the final response so future retries can replay it.
 * Must be called inside the same transaction as checkIdempotency.
 */
export async function saveIdempotencyResponse(client, { idempotencyKey, status, body }) {
  await client.query(
    `UPDATE idempotency_records SET response_status = $2, response_body = $3 WHERE idempotency_key = $1`,
    [idempotencyKey, status, JSON.stringify(body)],
  );
}
