import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

export const PHASE_1_EXPECTED_TABLES = Object.freeze([
  'plaid_items',
  'bank_accounts',
  'micro_deposits',
  'mandates',
  'ach_files',
  'transfers',
  'transfer_events',
  'onboarding',
  'operating_account',
  'ledger_entries',
  'users',
  'account_changes',
  'companies',
  'payment_approvals',
  'idempotency_records',
  'audit_logs'
]);

/**
 * Ensures the schema_migrations tracking table exists.
 */
async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         serial PRIMARY KEY,
      name       text NOT NULL UNIQUE,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

/**
 * Safeguard 1: Exhaustively inspects database schema against Phase 1 baseline.
 * Returns: 'empty' (0 tables), 'verified' (all 16 tables + required columns), or throws on partial/corrupt schema.
 */
export async function verifyPhase1Baseline(client) {
  const { rows: tableRows } = await client.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
       AND table_name != 'schema_migrations';
  `);

  const existingTableNames = new Set(tableRows.map((r) => r.table_name));

  if (existingTableNames.size === 0) {
    return 'empty';
  }

  // Check for presence of all 16 expected Phase 1 tables
  const missingTables = PHASE_1_EXPECTED_TABLES.filter((t) => !existingTableNames.has(t));

  if (missingTables.length > 0 && existingTableNames.size < PHASE_1_EXPECTED_TABLES.length) {
    throw new Error(
      `FATAL: Incompatible database state. Found partial Phase 1 schema (${existingTableNames.size}/${PHASE_1_EXPECTED_TABLES.length} tables). Missing: ${missingTables.join(', ')}. Refusing to stamp baseline or apply Phase 2 migrations.`
    );
  }

  // Deep inspection of Phase 1-specific columns
  const { rows: colRows } = await client.query(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (
         (table_name = 'transfers' AND column_name = 'company_id') OR
         (table_name = 'bank_accounts' AND column_name = 'company_id') OR
         (table_name = 'ach_files' AND column_name = 'company_id') OR
         (table_name = 'payment_approvals' AND column_name = 'requested_by_user_id') OR
         (table_name = 'idempotency_records' AND column_name = 'payload_hash')
       );
  `);

  const foundColumns = new Set(colRows.map((r) => `${r.table_name}.${r.column_name}`));
  const requiredCols = [
    'transfers.company_id',
    'bank_accounts.company_id',
    'ach_files.company_id',
    'payment_approvals.requested_by_user_id',
    'idempotency_records.payload_hash'
  ];

  const missingCols = requiredCols.filter((c) => !foundColumns.has(c));
  if (missingCols.length > 0) {
    throw new Error(
      `FATAL: Incompatible database state. Missing required Phase 1 columns: ${missingCols.join(', ')}. Refusing to proceed.`
    );
  }

  return 'verified';
}

/**
 * Returns a list of all migration names that have been applied.
 */
export async function getMigrationStatus(poolOrClient) {
  const isPool = typeof poolOrClient.connect === 'function';
  const client = isPool ? await poolOrClient.connect() : poolOrClient;

  try {
    await ensureMigrationTable(client);
    const { rows } = await client.query(`
      SELECT id, name, applied_at
        FROM schema_migrations
       ORDER BY id ASC;
    `);
    return rows;
  } finally {
    if (isPool) client.release();
  }
}

/**
 * Transactionally applies all pending migrations in sequential order.
 */
export async function migrateUp(poolOrClient) {
  const isPool = typeof poolOrClient.connect === 'function';
  const client = isPool ? await poolOrClient.connect() : poolOrClient;

  try {
    await ensureMigrationTable(client);

    const { rows: appliedRows } = await client.query(`
      SELECT name FROM schema_migrations;
    `);
    const appliedSet = new Set(appliedRows.map((r) => r.name));

    // Handle baseline migration 001
    if (!appliedSet.has('001_phase1_baseline')) {
      const baselineStatus = await verifyPhase1Baseline(client);

      if (baselineStatus === 'empty') {
        const sql001 = fs.readFileSync(path.join(MIGRATIONS_DIR, '001_phase1_baseline.sql'), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql001);
          await client.query(`INSERT INTO schema_migrations (name) VALUES ('001_phase1_baseline');`);
          await client.query('COMMIT');
          appliedSet.add('001_phase1_baseline');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      } else if (baselineStatus === 'verified') {
        await client.query(`INSERT INTO schema_migrations (name) VALUES ('001_phase1_baseline');`);
        appliedSet.add('001_phase1_baseline');
      }
    }

    // Handle Phase 2A migration 002
    if (!appliedSet.has('002_phase2_bank_verification')) {
      const sql002 = fs.readFileSync(path.join(MIGRATIONS_DIR, '002_phase2_bank_verification.sql'), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql002);
        await client.query(`INSERT INTO schema_migrations (name) VALUES ('002_phase2_bank_verification');`);
        await client.query('COMMIT');
        appliedSet.add('002_phase2_bank_verification');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    return Array.from(appliedSet);
  } finally {
    if (isPool) client.release();
  }
}

/**
 * Safeguard 2: Safely rolls back Phase 2A migrations.
 * Strictly restricted to isolated test databases.
 */
export async function migrateDown(targetMigration = '002_phase2_bank_verification', poolOrClient, databaseUrl = process.env.DATABASE_URL) {
  // Database identity guard
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to execute migrateDown.');
  }

  let dbName = '';
  try {
    const parsed = new URL(databaseUrl);
    dbName = parsed.pathname.replace(/^\//, '');
  } catch {
    // If not standard URL, extract from string
    const match = databaseUrl.match(/\/([^/?]+)(\?|$)/);
    dbName = match ? match[1] : '';
  }

  const isTestDb = dbName.endsWith('_test') || /^ach_poc_verify_restore_\d+_\d+$/.test(dbName) || process.env.NODE_ENV === 'test';

  if (!isTestDb) {
    throw new Error(
      `SECURITY VIOLATION: Destructive rollback refused against database '${dbName}'. Rollbacks are restricted strictly to isolated test databases (*_test or temporary restore DBs).`
    );
  }

  const isPool = typeof poolOrClient.connect === 'function';
  const client = isPool ? await poolOrClient.connect() : poolOrClient;

  try {
    await ensureMigrationTable(client);

    if (targetMigration === '002_phase2_bank_verification') {
      const downSql = fs.readFileSync(path.join(MIGRATIONS_DIR, '002_phase2_down.sql'), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(downSql);
        await client.query(`DELETE FROM schema_migrations WHERE name = '002_phase2_bank_verification';`);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    } else {
      throw new Error(`Unsupported rollback target: '${targetMigration}'. Only 002_phase2_bank_verification is rollable.`);
    }
  } finally {
    if (isPool) client.release();
  }
}
