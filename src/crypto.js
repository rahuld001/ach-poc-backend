import crypto from 'node:crypto';

// AES-256-GCM for account numbers, Plaid access tokens and NACHA file contents at rest.
// config.js refuses to start in live mode without a real ENCRYPTION_KEY; the default is for local test mode only.
const key = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY || 'dev-only-key').digest();

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('hex')).join(':');
}

export function decrypt(stored) {
  const [iv, tag, data] = stored.split(':').map((h) => Buffer.from(h, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** True for values produced by encrypt() (iv:tag:data in hex). A NACHA file never matches: it has spaces and newlines. */
export const isEncrypted = (value) => /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/.test(String(value ?? ''));

/** Decrypts values written by encrypt(); passes older plaintext rows through unchanged. */
export const decryptIfEncrypted = (value) => (isEncrypted(value) ? decrypt(value) : value);
