// Users, roles and sessions. In test mode the shared test API key still works (the simulated environment stays as easy to
// demo as before). In live mode browsers must sign in: the API key is for server-to-server use only and is never shipped
// to a browser.
//
// Roles: admin (everything, manages users), operator (creates and manages payments), viewer (read only).
import crypto from 'node:crypto';
import { query } from './db.js';
import { API_KEY, isTestMode } from './config.js';

export const ROLES = ['admin', 'operator', 'viewer'];
const SESSION_HOURS = Number(process.env.SESSION_HOURS ?? 8);
const secret = process.env.SESSION_SECRET || 'dev-only-session-secret';

// --- Passwords (scrypt, per-user salt) ---
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}
export function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

// --- Stateless signed session tokens: base64url(payload).hmac ---
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');
export function issueToken(user) {
  const payload = b64(JSON.stringify({ uid: user.id, role: user.role, exp: Date.now() + SESSION_HOURS * 3600_000 }));
  return `${payload}.${sign(payload)}`;
}
function readToken(token) {
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return data.exp > Date.now() ? data : null;
}

/** Creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD when the users table is empty. */
export async function seedAdmin() {
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = process.env;
  if (!email || !password) return;
  const { rows: [{ count }] } = await query('SELECT count(*)::int AS count FROM users');
  if (count > 0) return;
  await query(`INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, 'admin', $3)`, [email.toLowerCase(), 'Administrator', hashPassword(password)]);
  console.log(`[auth] created admin user ${email}`);
}

/**
 * Who is calling: a signed-in user, or the API key (test mode: anyone with the test key; live mode: server-to-server).
 * Sets req.user = { id, role, via }.
 */
export async function authenticate(req, res, next) {
  const token = req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Sign in required', login_required: !isTestMode });
  if (token === API_KEY) {
    req.user = { id: null, role: 'admin', via: 'api_key' };
    return next();
  }
  const session = readToken(token);
  if (!session) return res.status(401).json({ error: 'Session expired or invalid. Sign in again.', login_required: true });
  const { rows: [user] } = await query('SELECT id, role, disabled FROM users WHERE id = $1', [session.uid]);
  if (!user || user.disabled) return res.status(401).json({ error: 'This user no longer has access', login_required: true });
  req.user = { id: user.id, role: user.role, via: 'session' };
  next();
}

/** Viewers are read only. Admin-only areas use requireRole('admin'). */
export function enforceRole(req, res, next) {
  if (req.method !== 'GET' && req.user?.role === 'viewer') return res.status(403).json({ error: 'Your role is read only' });
  next();
}
export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
