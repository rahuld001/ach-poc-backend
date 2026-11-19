import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const testPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

test('Schema: All 19 expected tables exist in PostgreSQL database', async () => {
  const { rows } = await testPool.query(`
    SELECT table_name FROM information_schema.tables 
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name != 'schema_migrations'
     ORDER BY table_name;
  `);

  const EXPECTED_TABLES = [
    'account_changes', 'ach_files', 'audit_logs', 'bank_accounts',
    'companies', 'idempotency_records', 'ip_velocity_events',
    'ledger_entries', 'mandates', 'micro_deposit_cycles',
    'micro_deposits', 'micro_entry_fraud_alerts', 'onboarding',
    'operating_account', 'payment_approvals', 'plaid_items',
    'transfer_events', 'transfers', 'users'
  ];

  const actualTables = rows.map((r) => r.table_name);
  assert.equal(actualTables.length, 19, `Expected 19 tables, got ${actualTables.length}`);
  for (const t of EXPECTED_TABLES) {
    assert.ok(actualTables.includes(t), `Missing table: ${t}`);
  }
});

test('Constraints: micro_deposit_cycles enforces offset amount check constraint', async () => {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [acc] } = await client.query(`
      INSERT INTO bank_accounts (holder_name, routing_number, account_number_enc, last4, account_type, source, status, account_classification)
      VALUES ('Test Corp', '121000358', 'enc_123', '1234', 'checking', 'manual', 'pending_verification', 'business')
      RETURNING id;
    `);

    // Valid insertion: offset equals amount1 + amount2 (15 + 25 = 40)
    const validInsert = await client.query(`
      INSERT INTO micro_deposit_cycles (
        bank_account_id, cycle_number, amount1_cents, amount2_cents, offset_amount_cents,
        credit_sec_code, debit_sec_code, expires_at
      ) VALUES ($1, 1, 15, 25, 40, 'CCD', 'CCD', now() + interval '5 days')
      RETURNING id;
    `, [acc.id]);
    assert.ok(validInsert.rows[0].id);

    // Invalid insertion: offset does NOT equal amount1 + amount2 (15 + 25 != 50)
    await assert.rejects(
      async () => {
        await client.query(`
          INSERT INTO micro_deposit_cycles (
            bank_account_id, cycle_number, amount1_cents, amount2_cents, offset_amount_cents,
            credit_sec_code, debit_sec_code, expires_at
          ) VALUES ($1, 2, 15, 25, 50, 'CCD', 'CCD', now() + interval '5 days');
        `, [acc.id]);
      },
      (err) => err.code === '23514' && err.constraint === 'chk_offset_amount'
    );

    await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

test('Constraints: micro_deposit_cycles enforces unique (bank_account_id, cycle_number)', async () => {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [acc] } = await client.query(`
      INSERT INTO bank_accounts (holder_name, routing_number, account_number_enc, last4, account_type, source, status, account_classification)
      VALUES ('Jane Doe', '121000358', 'enc_456', '5678', 'checking', 'manual', 'pending_verification', 'consumer')
      RETURNING id;
    `);

    // Cycle 1
    await client.query(`
      INSERT INTO micro_deposit_cycles (
        bank_account_id, cycle_number, amount1_cents, amount2_cents, offset_amount_cents,
        credit_sec_code, debit_sec_code, expires_at
      ) VALUES ($1, 1, 20, 30, 50, 'WEB', 'WEB', now() + interval '5 days');
    `, [acc.id]);

    // Duplicate Cycle 1 for same account must fail
    await assert.rejects(
      async () => {
        await client.query(`
          INSERT INTO micro_deposit_cycles (
            bank_account_id, cycle_number, amount1_cents, amount2_cents, offset_amount_cents,
            credit_sec_code, debit_sec_code, expires_at
          ) VALUES ($1, 1, 10, 20, 30, 'WEB', 'WEB', now() + interval '5 days');
        `, [acc.id]);
      },
      (err) => err.code === '23505' && err.constraint === 'unq_account_cycle'
    );

    await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

test('Constraints: micro_entry_fraud_alerts enforces alert_type CHECK constraint', async () => {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [acc] } = await client.query(`
      INSERT INTO bank_accounts (holder_name, routing_number, account_number_enc, last4, account_type, source, status, account_classification)
      VALUES ('Fraud Test', '121000358', 'enc_789', '9012', 'checking', 'manual', 'pending_verification', 'consumer')
      RETURNING id;
    `);

    // Valid: alert_type 'velocity_spike'
    const valid = await client.query(`
      INSERT INTO micro_entry_fraud_alerts (bank_account_id, ip_address, alert_type, severity, details)
      VALUES ($1, '127.0.0.1'::inet, 'velocity_spike', 'high', '{"metric":"daily_count"}')
      RETURNING id, alert_type;
    `, [acc.id]);
    assert.equal(valid.rows[0].alert_type, 'velocity_spike');

    // Invalid: alert_type 'velocity_daily_count_exceeded' must fail
    await assert.rejects(
      async () => {
        await client.query(`
          INSERT INTO micro_entry_fraud_alerts (bank_account_id, ip_address, alert_type, severity, details)
          VALUES ($1, '127.0.0.1'::inet, 'velocity_daily_count_exceeded', 'high', '{}');
        `, [acc.id]);
      },
      (err) => err.code === '23514' && err.constraint === 'micro_entry_fraud_alerts_alert_type_check'
    );

    await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

test('Immutability: audit_logs UPDATE is blocked by row-level trigger', async () => {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [log] } = await client.query(`
      INSERT INTO audit_logs (action, resource_type, outcome)
      VALUES ('TEST_ACTION', 'test_resource', 'success')
      RETURNING id;
    `);

    await assert.rejects(
      async () => {
        await client.query(`UPDATE audit_logs SET outcome = 'failure' WHERE id = $1;`, [log.id]);
      },
      (err) => err.message.includes('audit_logs is an immutable append-only ledger')
    );

    await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

test('Immutability: audit_logs DELETE is blocked by row-level trigger', async () => {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [log] } = await client.query(`
      INSERT INTO audit_logs (action, resource_type, outcome)
      VALUES ('TEST_DELETE', 'test_resource', 'success')
      RETURNING id;
    `);

    await assert.rejects(
      async () => {
        await client.query(`DELETE FROM audit_logs WHERE id = $1;`, [log.id]);
      },
      (err) => err.message.includes('audit_logs is an immutable append-only ledger')
    );

    await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

test('Immutability: audit_logs TRUNCATE is blocked by statement-level trigger', async () => {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');

    await assert.rejects(
      async () => {
        await client.query('TRUNCATE TABLE audit_logs;');
      },
      (err) => err.message.includes('audit_logs is an immutable append-only ledger')
    );

    await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

test('Legacy Compatibility: micro_deposits maintains 1:1 PK and synchronizes latest cycle', async () => {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [acc] } = await client.query(`
      INSERT INTO bank_accounts (holder_name, routing_number, account_number_enc, last4, account_type, source, status, account_classification)
      VALUES ('Multi-Cycle User', '121000358', 'enc_multi', '3344', 'checking', 'manual', 'pending_verification', 'consumer')
      RETURNING id;
    `);

    // 1. Cycle 1 initiated
    const { rows: [cycle1] } = await client.query(`
      INSERT INTO micro_deposit_cycles (
        bank_account_id, cycle_number, amount1_cents, amount2_cents, offset_amount_cents,
        credit_sec_code, debit_sec_code, status, expires_at
      ) VALUES ($1, 1, 12, 28, 40, 'WEB', 'WEB', 'initiated', now() + interval '5 days')
      RETURNING id;
    `, [acc.id]);

    // Upsert snapshot into micro_deposits
    await client.query(`
      INSERT INTO micro_deposits (
        bank_account_id, cycle_id, cycle_number, amount1_cents, amount2_cents,
        attempts, expires_at, status, updated_at
      ) VALUES ($1, $2, 1, 12, 28, 0, now() + interval '5 days', 'initiated', now())
      ON CONFLICT (bank_account_id) DO UPDATE SET
        cycle_id = EXCLUDED.cycle_id,
        cycle_number = EXCLUDED.cycle_number,
        amount1_cents = EXCLUDED.amount1_cents,
        amount2_cents = EXCLUDED.amount2_cents,
        attempts = EXCLUDED.attempts,
        expires_at = EXCLUDED.expires_at,
        status = EXCLUDED.status,
        updated_at = now();
    `, [acc.id, cycle1.id]);

    // Check Cycle 1 snapshot
    const snap1 = await client.query(`SELECT * FROM micro_deposits WHERE bank_account_id = $1`, [acc.id]);
    assert.equal(snap1.rows.length, 1);
    assert.equal(snap1.rows[0].cycle_number, 1);
    assert.equal(snap1.rows[0].status, 'initiated');
    assert.equal(snap1.rows[0].amount1_cents, 12);

    // 2. Cycle 1 fails
    await client.query(`UPDATE micro_deposit_cycles SET status = 'failed', attempts_used = 3 WHERE id = $1`, [cycle1.id]);
    await client.query(`UPDATE micro_deposits SET status = 'failed', attempts = 3 WHERE bank_account_id = $1`, [acc.id]);

    // 3. Cycle 2 re-initiated for same bank account
    const { rows: [cycle2] } = await client.query(`
      INSERT INTO micro_deposit_cycles (
        bank_account_id, cycle_number, amount1_cents, amount2_cents, offset_amount_cents,
        credit_sec_code, debit_sec_code, status, expires_at
      ) VALUES ($1, 2, 35, 45, 80, 'WEB', 'WEB', 'initiated', now() + interval '5 days')
      RETURNING id;
    `, [acc.id]);

    // Upsert snapshot into micro_deposits
    await client.query(`
      INSERT INTO micro_deposits (
        bank_account_id, cycle_id, cycle_number, amount1_cents, amount2_cents,
        attempts, expires_at, status, updated_at
      ) VALUES ($1, $2, 2, 35, 45, 0, now() + interval '5 days', 'initiated', now())
      ON CONFLICT (bank_account_id) DO UPDATE SET
        cycle_id = EXCLUDED.cycle_id,
        cycle_number = EXCLUDED.cycle_number,
        amount1_cents = EXCLUDED.amount1_cents,
        amount2_cents = EXCLUDED.amount2_cents,
        attempts = EXCLUDED.attempts,
        expires_at = EXCLUDED.expires_at,
        status = EXCLUDED.status,
        updated_at = now();
    `, [acc.id, cycle2.id]);

    // Authoritative cycles table has BOTH cycles preserved
    const cycles = await client.query(`SELECT cycle_number, status FROM micro_deposit_cycles WHERE bank_account_id = $1 ORDER BY cycle_number`, [acc.id]);
    assert.equal(cycles.rows.length, 2);
    assert.equal(cycles.rows[0].cycle_number, 1);
    assert.equal(cycles.rows[0].status, 'failed');
    assert.equal(cycles.rows[1].cycle_number, 2);
    assert.equal(cycles.rows[1].status, 'initiated');

    // Legacy micro_deposits snapshot table still has EXACTLY 1 row, now pointing to Cycle 2
    const snap2 = await client.query(`SELECT * FROM micro_deposits WHERE bank_account_id = $1`, [acc.id]);
    assert.equal(snap2.rows.length, 1);
    assert.equal(snap2.rows[0].cycle_id, cycle2.id);
    assert.equal(snap2.rows[0].cycle_number, 2);
    assert.equal(snap2.rows[0].amount1_cents, 35);
    assert.equal(snap2.rows[0].amount2_cents, 45);
    assert.equal(snap2.rows[0].attempts, 0);
    assert.equal(snap2.rows[0].status, 'initiated');

    await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await testPool.end();
  }
});
