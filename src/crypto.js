import crypto from 'node:crypto';

// AES-256-GCM for account numbers and Plaid access tokens at rest.
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
