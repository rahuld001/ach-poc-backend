import pg from 'pg';
import { migrateUp } from './migrate.js';

// Return DATE columns as 'YYYY-MM-DD' strings instead of local-time JS Dates.
pg.types.setTypeParser(1082, (v) => v);
// Return BIGINT columns as numbers (amounts in cents stay well within 2^53).
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const query = (text, params) => pool.query(text, params);

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function initDb() {
  await migrateUp(pool);
}
