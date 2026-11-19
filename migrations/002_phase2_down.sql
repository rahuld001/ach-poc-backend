-- ============================================================
-- ACH POC – Migration 002: Rollback Script (Phase 2A -> Phase 1)
-- ============================================================

-- 1. Remove Audit Log Immutability Triggers and Function
DROP TRIGGER IF EXISTS trg_audit_logs_stmt_truncate ON audit_logs;
DROP TRIGGER IF EXISTS trg_audit_logs_row_immutable ON audit_logs;
DROP FUNCTION IF EXISTS audit_logs_reject_mutation();

-- 2. Drop Phase 2 Tables (dependent tables first)
DROP TABLE IF EXISTS micro_entry_fraud_alerts CASCADE;
DROP TABLE IF EXISTS ip_velocity_events CASCADE;

-- 3. Remove Circular Foreign Keys and Legacy Synchronization Linkage
ALTER TABLE bank_accounts DROP COLUMN IF EXISTS last_verification_cycle_id CASCADE;

ALTER TABLE micro_deposits DROP COLUMN IF EXISTS cycle_id CASCADE;
ALTER TABLE micro_deposits DROP COLUMN IF EXISTS status CASCADE;
ALTER TABLE micro_deposits DROP COLUMN IF EXISTS cycle_number CASCADE;
ALTER TABLE micro_deposits DROP COLUMN IF EXISTS updated_at CASCADE;

-- 4. Drop Authoritative Cycles Table
DROP TABLE IF EXISTS micro_deposit_cycles CASCADE;

-- 5. Revert Mandates Phase 2 Columns and Indexes
DROP INDEX IF EXISTS mandates_account_status_idx;
ALTER TABLE mandates DROP COLUMN IF EXISTS authorization_type CASCADE;
ALTER TABLE mandates DROP COLUMN IF EXISTS authorization_scope CASCADE;
ALTER TABLE mandates DROP COLUMN IF EXISTS authorization_method CASCADE;
ALTER TABLE mandates DROP COLUMN IF EXISTS intended_sec_code CASCADE;
ALTER TABLE mandates DROP COLUMN IF EXISTS micro_entry_sec_code CASCADE;
ALTER TABLE mandates DROP COLUMN IF EXISTS status CASCADE;
ALTER TABLE mandates DROP COLUMN IF EXISTS actor_user_id CASCADE;
ALTER TABLE mandates DROP COLUMN IF EXISTS mandate_version CASCADE;
ALTER TABLE mandates DROP COLUMN IF EXISTS revoked_at CASCADE;
ALTER TABLE mandates DROP COLUMN IF EXISTS revoked_reason CASCADE;

-- 6. Revert Bank Accounts Phase 2 Columns and Status Check
ALTER TABLE bank_accounts DROP COLUMN IF EXISTS account_classification CASCADE;
ALTER TABLE bank_accounts DROP COLUMN IF EXISTS verification_method CASCADE;
ALTER TABLE bank_accounts DROP COLUMN IF EXISTS verification_status CASCADE;
ALTER TABLE bank_accounts DROP COLUMN IF EXISTS verification_cycle_count CASCADE;
ALTER TABLE bank_accounts DROP COLUMN IF EXISTS verified_at CASCADE;

-- Restore Phase 1 status check constraint
ALTER TABLE bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_status_check;
ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_status_check
  CHECK (status IN ('pending_verification', 'verified', 'disabled'));
