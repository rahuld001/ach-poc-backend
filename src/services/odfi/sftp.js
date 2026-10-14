// Real-bank transport: NACHA files exchanged with the ODFI over SFTP. This is the piece that replaces the simulated
// bank when going live. Enable with ODFI_TRANSPORT=sftp, `npm install ssh2-sftp-client`, and the SFTP_* variables.
//
// Bank-specific pieces are marked BANK-SPECIFIC: file naming, PGP encryption of the file body, the acknowledgment
// file format, and the inbound folder layout all come from the ODFI's origination guide.
import { query, withTx } from '../../db.js';
import { setTransferStatus } from '../transfers.js';
import { applyInboundFile } from '../inbound.js';

const cfg = {
  host: process.env.SFTP_HOST,
  port: Number(process.env.SFTP_PORT ?? 22),
  username: process.env.SFTP_USERNAME,
  password: process.env.SFTP_PASSWORD,
  privateKey: process.env.SFTP_PRIVATE_KEY, // PEM contents, alternative to a password
  outboundDir: process.env.SFTP_OUTBOUND_DIR || '/outbound',
  inboundDir: process.env.SFTP_INBOUND_DIR || '/inbound',
  processedDir: process.env.SFTP_PROCESSED_DIR || '/inbound/processed',
};

// PGP: files to the bank are encrypted with the bank's public key; files from the bank are decrypted with ours.
// Keys are ASCII-armored, passed in env (literal \n escapes allowed). Needs `npm install openpgp`.
const pgpKey = (name) => process.env[name]?.replace(/\\n/g, '\n');
async function pgp() {
  try {
    return await import('openpgp');
  } catch {
    throw new Error('PGP keys are configured but the openpgp package is missing: npm install openpgp');
  }
}
export async function encryptForBank(content) {
  const armored = pgpKey('ODFI_PGP_PUBLIC_KEY');
  if (!armored) return content;
  const openpgp = await pgp();
  const encryptionKeys = await openpgp.readKey({ armoredKey: armored });
  return openpgp.encrypt({ message: await openpgp.createMessage({ text: content }), encryptionKeys });
}
export async function decryptFromBank(content) {
  const armored = pgpKey('COMPANY_PGP_PRIVATE_KEY');
  if (!armored || !content.includes('BEGIN PGP MESSAGE')) return content;
  const openpgp = await pgp();
  let privateKey = await openpgp.readPrivateKey({ armoredKey: armored });
  if (process.env.COMPANY_PGP_PASSPHRASE) privateKey = await openpgp.decryptKey({ privateKey, passphrase: process.env.COMPANY_PGP_PASSPHRASE });
  const { data } = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: content }), decryptionKeys: privateKey });
  return data;
}

async function connect() {
  if (!cfg.host || !cfg.username) throw new Error('ODFI_TRANSPORT=sftp needs SFTP_HOST and SFTP_USERNAME');
  let Sftp;
  try {
    ({ default: Sftp } = await import('ssh2-sftp-client'));
  } catch {
    throw new Error('ODFI_TRANSPORT=sftp needs the ssh2-sftp-client package: npm install ssh2-sftp-client');
  }
  const client = new Sftp();
  await client.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, privateKey: cfg.privateKey });
  return client;
}

/** Uploads an origination file. Called inside the batch transaction, so a failed upload leaves the entries pending. */
export async function send({ fileName, content }) {
  const client = await connect();
  try {
    const body = await encryptForBank(content); // PGP when ODFI_PGP_PUBLIC_KEY is set
    const name = body === content ? fileName : `${fileName}.pgp`;
    await client.put(Buffer.from(body, 'ascii'), `${cfg.outboundDir}/${name}`);
  } finally {
    await client.end();
  }
}

/**
 * Acknowledgments. BANK-SPECIFIC: ODFIs confirm receipt with an acknowledgment file (often a copy of the file control
 * record or a CSV of accepted/rejected batches) in the inbound folder. Until that format is implemented, a file counts
 * as accepted once its upload succeeded, which is what most SFTP origination setups treat as delivery.
 */
export async function acknowledgeDueFiles() {
  return withTx(async (client) => {
    const { rows: files } = await client.query(
      `SELECT * FROM ach_files WHERE kind = 'origination' AND status = 'submitted' AND transport = 'sftp' FOR UPDATE SKIP LOCKED`,
    );
    for (const file of files) {
      const { rows: transfers } = await client.query(`SELECT * FROM transfers WHERE ach_file_id = $1 AND status = 'submitted'`, [file.id]);
      for (const t of transfers) await setTransferStatus(client, t.id, 'accepted', `File ${file.file_name} delivered to the ODFI over SFTP`);
      await client.query(`UPDATE ach_files SET status = 'accepted', acknowledged_at = now(), bank_response = $2 WHERE id = $1`, [
        file.id,
        JSON.stringify({ ack: { accepted: true, message: 'Uploaded to ODFI SFTP outbound folder' } }),
      ]);
    }
    return files.length;
  });
}

/** Downloads new return / NOC files from the inbound folder, applies them, and moves them to the processed folder. */
export async function collectInbound() {
  const client = await connect();
  let applied = 0;
  try {
    const listing = await client.list(cfg.inboundDir);
    for (const entry of listing.filter((e) => e.type === '-')) {
      const { rows: [seen] } = await query(`SELECT 1 FROM ach_files WHERE kind = 'return' AND file_name = $1`, [entry.name]);
      if (seen) continue;
      const content = await decryptFromBank((await client.get(`${cfg.inboundDir}/${entry.name}`)).toString('ascii'));
      await applyInboundFile(content, { transport: 'sftp', fileName: entry.name });
      await client.rename(`${cfg.inboundDir}/${entry.name}`, `${cfg.processedDir}/${entry.name}`).catch(() => {});
      applied++;
    }
  } finally {
    await client.end();
  }
  return applied;
}
