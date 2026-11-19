// Phase 1 – Core Foundation tests.
// These tests cover pure functions only (no database, no network).
// Tests that require a live database are integration tests and are run separately.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// --- Rate limiter ---
import { rateLimit } from '../src/middleware/rateLimit.js';

test('rateLimit: allows requests up to the configured maximum', () => {
  const max = 3;
  const middleware = rateLimit({ max, keyFn: () => 'test-key-allow' });
  const mockRes = { status: () => mockRes, json: () => {} };
  let nextCalled = 0;

  for (let i = 0; i < max; i++) {
    middleware({ ip: '1.2.3.4' }, mockRes, () => { nextCalled++; });
  }
  assert.equal(nextCalled, max, 'All requests within limit should pass through');
});

test('rateLimit: blocks requests over the limit', () => {
  const max = 2;
  const middleware = rateLimit({ max, keyFn: () => 'test-key-block' });
  let blocked = false;
  const mockRes = {
    status: (code) => { if (code === 429) blocked = true; return mockRes; },
    json: () => {},
  };

  for (let i = 0; i < max + 1; i++) {
    middleware({ ip: '1.2.3.4' }, mockRes, () => {});
  }
  assert.ok(blocked, 'The request over the limit should be blocked with 429');
});

test('rateLimit: separate keys have independent counters', () => {
  const max = 1;
  const middleware = rateLimit({ max, keyFn: (req) => req.key });
  let blocked = false;
  const mockRes = {
    status: (code) => { if (code === 429) blocked = true; return mockRes; },
    json: () => {},
  };

  middleware({ key: 'user-A' }, mockRes, () => {});
  middleware({ key: 'user-B' }, mockRes, () => {});
  assert.ok(!blocked, 'Different keys should not affect each other');
});

// --- Idempotency payload hash ---
import { computePayloadHash } from '../src/middleware/idempotency.js';

test('computePayloadHash: produces a 64-char hex SHA-256 string', () => {
  const hash = computePayloadHash({ bank_account_id: 'abc', direction: 'debit', amount_cents: 5000, rail: 'mock' });
  assert.match(hash, /^[0-9a-f]{64}$/, 'Hash must be 64-char lowercase hex');
});

test('computePayloadHash: same fields in different order produce the same hash', () => {
  const a = computePayloadHash({ bank_account_id: 'x', direction: 'credit', amount_cents: 1000, rail: 'mock' });
  const b = computePayloadHash({ direction: 'credit', rail: 'mock', amount_cents: 1000, bank_account_id: 'x' });
  assert.equal(a, b, 'Key ordering must not affect the hash');
});

test('computePayloadHash: different amounts produce different hashes', () => {
  const a = computePayloadHash({ bank_account_id: 'x', direction: 'debit', amount_cents: 1000, rail: 'mock' });
  const b = computePayloadHash({ bank_account_id: 'x', direction: 'debit', amount_cents: 2000, rail: 'mock' });
  assert.notEqual(a, b, 'Different amounts must produce different hashes');
});

test('computePayloadHash: different directions produce different hashes', () => {
  const a = computePayloadHash({ bank_account_id: 'x', direction: 'debit', amount_cents: 500, rail: 'mock' });
  const b = computePayloadHash({ bank_account_id: 'x', direction: 'credit', amount_cents: 500, rail: 'mock' });
  assert.notEqual(a, b);
});

// --- Auth: RBAC middleware ---
import { enforceRole, requireRole, ROLES, APPROVER_ROLES, dualApprovalThresholdCents } from '../src/auth.js';

test('ROLES includes approver', () => {
  assert.ok(ROLES.includes('approver'), 'approver must be in ROLES');
  assert.ok(ROLES.includes('admin'));
  assert.ok(ROLES.includes('operator'));
  assert.ok(ROLES.includes('viewer'));
});

test('APPROVER_ROLES includes admin and approver only', () => {
  assert.ok(APPROVER_ROLES.includes('admin'));
  assert.ok(APPROVER_ROLES.includes('approver'));
  assert.ok(!APPROVER_ROLES.includes('operator'), 'operator must not be in APPROVER_ROLES');
  assert.ok(!APPROVER_ROLES.includes('viewer'), 'viewer must not be in APPROVER_ROLES');
});

test('dualApprovalThresholdCents: returns configured value from env', () => {
  const original = process.env.DUAL_APPROVAL_THRESHOLD_CENTS;
  process.env.DUAL_APPROVAL_THRESHOLD_CENTS = '500000';
  assert.equal(dualApprovalThresholdCents(), 500000);
  if (original === undefined) delete process.env.DUAL_APPROVAL_THRESHOLD_CENTS;
  else process.env.DUAL_APPROVAL_THRESHOLD_CENTS = original;
});

test('dualApprovalThresholdCents: defaults to 1,000,000 cents ($10,000)', () => {
  const original = process.env.DUAL_APPROVAL_THRESHOLD_CENTS;
  delete process.env.DUAL_APPROVAL_THRESHOLD_CENTS;
  assert.equal(dualApprovalThresholdCents(), 1_000_000);
  if (original !== undefined) process.env.DUAL_APPROVAL_THRESHOLD_CENTS = original;
});

test('enforceRole: viewer cannot make non-GET requests', () => {
  let status = null;
  const req = { method: 'POST', user: { role: 'viewer' } };
  const res = { status: (s) => { status = s; return res; }, json: () => {} };
  enforceRole(req, res, () => { status = 200; });
  assert.equal(status, 403, 'viewer must be blocked from POST');
});

test('enforceRole: viewer can make GET requests', () => {
  let passed = false;
  const req = { method: 'GET', user: { role: 'viewer' } };
  enforceRole(req, {}, () => { passed = true; });
  assert.ok(passed, 'viewer must be allowed for GET');
});

test('enforceRole: operator can make POST requests', () => {
  let passed = false;
  const req = { method: 'POST', user: { role: 'operator' } };
  enforceRole(req, {}, () => { passed = true; });
  assert.ok(passed, 'operator must be allowed for POST');
});

test('requireRole: allows exact role match', () => {
  let passed = false;
  const req = { user: { role: 'admin' } };
  requireRole('admin')(req, {}, () => { passed = true; });
  assert.ok(passed);
});

test('requireRole: allows any matching role from multiple', () => {
  let passed = false;
  const req = { user: { role: 'approver' } };
  requireRole('admin', 'approver')(req, {}, () => { passed = true; });
  assert.ok(passed, 'approver should be allowed when admin or approver is required');
});

test('requireRole: rejects non-matching role', () => {
  let status = null;
  const req = { user: { role: 'operator' } };
  const res = { status: (s) => { status = s; return res; }, json: () => {} };
  requireRole('admin')(req, res, () => {});
  assert.equal(status, 403);
});

test('requireRole: operator cannot approve (approver role required)', () => {
  let status = null;
  const req = { user: { role: 'operator' } };
  const res = { status: (s) => { status = s; return res; }, json: () => {} };
  requireRole('admin', 'approver')(req, res, () => {});
  assert.equal(status, 403, 'operator must not be able to approve payments');
});

// --- Encryption: tamper detection ---
import { encrypt, decrypt } from '../src/crypto.js';

test('encrypt/decrypt round trip', () => {
  const plain = '123456789012345';
  assert.equal(decrypt(encrypt(plain)), plain, 'Decrypted value must match original');
});

test('tampered ciphertext is rejected by GCM auth tag', () => {
  const enc = encrypt('9876543210');
  // Flip the last character of the ciphertext portion (after second colon)
  const parts = enc.split(':');
  parts[2] = parts[2].slice(0, -2) + (parts[2].slice(-2) === 'ff' ? '00' : 'ff');
  const tampered = parts.join(':');
  assert.throws(() => decrypt(tampered), 'Tampered ciphertext must throw');
});
