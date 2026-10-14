import { Router } from 'express';
import { query } from '../db.js';
import { ROLES, authenticate, hashPassword, issueToken, requireRole, verifyPassword } from '../auth.js';
import { isTestMode } from '../config.js';
import { HttpError } from '../services/transfers.js';

// Public: what the UI needs before anyone has signed in.
export const publicAuth = Router();

publicAuth.get('/status', (_req, res) => res.json({ mode: isTestMode ? 'test' : 'live', login_required: !isTestMode }));

// Simple brute-force brake: 10 failed attempts per email per 15 minutes.
const failures = new Map();
publicAuth.post('/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!email || !password) throw new HttpError(400, 'Email and password are required');
  const f = failures.get(email);
  if (f && f.count >= 10 && Date.now() - f.first < 15 * 60_000) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');

  const { rows: [user] } = await query('SELECT * FROM users WHERE email = $1', [email]);
  if (!user || user.disabled || !verifyPassword(password, user.password_hash)) {
    const cur = f && Date.now() - f.first < 15 * 60_000 ? f : { count: 0, first: Date.now() };
    failures.set(email, { ...cur, count: cur.count + 1 });
    throw new HttpError(401, 'Email or password is incorrect');
  }
  failures.delete(email);
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  res.json({ token: issueToken(user), user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

// Signed in.
export const privateAuth = Router();
privateAuth.use(authenticate);

privateAuth.get('/me', async (req, res) => {
  if (!req.user.id) return res.json({ id: null, name: 'API key', role: req.user.role, via: req.user.via });
  const { rows: [u] } = await query('SELECT id, email, name, role FROM users WHERE id = $1', [req.user.id]);
  res.json({ ...u, via: req.user.via });
});

privateAuth.get('/users', requireRole('admin'), async (_req, res) => {
  const { rows } = await query('SELECT id, email, name, role, disabled, last_login_at, created_at FROM users ORDER BY created_at');
  res.json(rows);
});

privateAuth.post('/users', requireRole('admin'), async (req, res) => {
  const { email, name, role = 'viewer', password } = req.body ?? {};
  if (!/^[^@\s]+@[^@\s]+$/.test(String(email ?? ''))) throw new HttpError(400, 'A valid email is required');
  if (!ROLES.includes(role)) throw new HttpError(400, `role must be one of ${ROLES.join(', ')}`);
  if (String(password ?? '').length < 12) throw new HttpError(400, 'Password must be at least 12 characters');
  const { rows: [u] } = await query(
    `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role, created_at`,
    [email.trim().toLowerCase(), name?.trim() || email, role, hashPassword(password)],
  );
  res.status(201).json(u);
});

privateAuth.patch('/users/:id', requireRole('admin'), async (req, res) => {
  const { role, disabled } = req.body ?? {};
  if (role !== undefined && !ROLES.includes(role)) throw new HttpError(400, `role must be one of ${ROLES.join(', ')}`);
  if (req.params.id === req.user.id && (disabled === true || (role && role !== 'admin'))) throw new HttpError(409, 'You cannot remove your own admin access');
  const { rows: [u] } = await query(
    `UPDATE users SET role = coalesce($2, role), disabled = coalesce($3, disabled) WHERE id = $1 RETURNING id, email, name, role, disabled`,
    [req.params.id, role ?? null, typeof disabled === 'boolean' ? disabled : null],
  );
  if (!u) throw new HttpError(404, 'User not found');
  res.json(u);
});
