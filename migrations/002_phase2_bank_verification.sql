-- ============================================================
-- ACH POC – Migration 002: Phase 2A Bank Verification Schema
-- ============================================================

-- 1. Authoritative Micro-Deposit Cycles Table
CREATE TABLE IF NOT EXISTS micro_deposit_cycles (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id      uuid NOT NULL REFERENCES bank_accounts(id),
  mandate_id           uuid REFERENCES mandates(id),
  cycle_number         int NOT NULL,
  amount1_cents        int NOT NULL CHECK (amount1_cents BETWEEN 1 AND 99),
  amount2_cents        int NOT NULL CHECK (amount2_cents BETWEEN 1 AND 99),
  offset_amount_cents  int NOT NULL,
  status               text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated', 'sent', 'completed', 'failed', 'expired', 'disabled')),
  attempts_used        int NOT NULL DEFAULT 0 CHECK (attempts_used >= 0),
  max_attempts         int NOT NULL DEFAULT 3,
  credit_sec_code      char(3) NOT NULL CHECK (credit_sec_code IN ('WEB', 'PPD', 'CCD')),
  debit_sec_code       char(3) NOT NULL CHECK (debit_sec_code IN ('WEB', 'PPD', 'CCD')),
  credit_transfer_id_1 uuid REFERENCES transfers(id),
  credit_transfer_id_2 uuid REFERENCES transfers(id),
  debit_transfer_id    uuid REFERENCES transfers(id),
  completed_at         timestamptz,
  expires_at           timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unq_account_cycle UNIQUE (bank_account_id, cycle_number),
  CONSTRAINT chk_offset_amount CHECK (offset_amount_cents = amount1_cents + amount2_cents)
);

CREATE INDEX IF NOT EXISTS micro_deposit_cycles_account_idx ON micro_deposit_cycles(bank_account_id);
CREATE INDEX IF NOT EXISTS micro_deposit_cycles_status_idx  ON micro_deposit_cycles(status);

-- 2. Bank Accounts Phase 2 Columns & Classification
-- Note: account_classification has NO default to protect existing records
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS account_classification text CHECK (account_classification IN ('consumer', 'business'));
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS verification_method text CHECK (verification_method IN ('plaid', 'micro_deposit', 'prenote'));
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS verification_status text CHECK (verification_status IN ('unverified', 'pending', 'verified', 'failed'));
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS verification_cycle_count int NOT NULL DEFAULT 0;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS last_verification_cycle_id uuid REFERENCES micro_deposit_cycles(id);

-- Expand bank_accounts status check constraint to include 'failed'
ALTER TABLE bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_status_check;
ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_status_check
  CHECK (status IN ('pending_verification', 'verified', 'disabled', 'failed'));

-- 3. Mandates Phase 2 Authorization Metadata
ALTER TABLE mandates ADD COLUMN IF NOT EXISTS authorization_type text NOT NULL DEFAULT 'debit'
  CHECK (authorization_type IN ('verification', 'debit', 'credit'));
ALTER TABLE mandates ADD COLUMN IF NOT EXISTS authorization_scope text NOT NULL DEFAULT 'verification_and_payments'
  CHECK (authorization_scope IN ('verification_only', 'payments_only', 'verification_and_payments'));
ALTER TABLE mandates ADD COLUMN IF NOT EXISTS authorization_method text NOT NULL DEFAULT 'web_electronic'
  CHECK (authorization_method IN ('web_electronic', 'written_standing', 'corporate_agreement'));
ALTER TABLE mandates ADD COLUMN IF NOT EXISTS intended_sec_code char(3)
  CHECK (intended_sec_code IN ('WEB', 'PPD', 'CCD'));
ALTER TABLE mandates ADD COLUMN IF NOT EXISTS micro_entry_sec_code char(3)
  CHECK (micro_entry_sec_code IN ('WEB', 'PPD', 'CCD'));
ALTER TABLE mandates ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'revoked', 'superseded'));
ALTER TABLE mandates ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES users(id);
ALTER TABLE mandates ADD COLUMN IF NOT EXISTS mandate_version text NOT NULL DEFAULT '1.0';
ALTER TABLE mandates ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE mandates ADD COLUMN IF NOT EXISTS revoked_reason text;

CREATE INDEX IF NOT EXISTS mandates_account_status_idx ON mandates(bank_account_id, status);

-- 4. Legacy micro_deposits Snapshot Synchronization Table
-- Preserves bank_account_id PRIMARY KEY while adding cycle linkage
ALTER TABLE micro_deposits ADD COLUMN IF NOT EXISTS cycle_id uuid REFERENCES micro_deposit_cycles(id);
ALTER TABLE micro_deposits ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'initiated'
  CHECK (status IN ('initiated', 'sent', 'completed', 'failed', 'expired', 'disabled'));
ALTER TABLE micro_deposits ADD COLUMN IF NOT EXISTS cycle_number int NOT NULL DEFAULT 1;
ALTER TABLE micro_deposits ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- 5. IP Velocity Events Table
CREATE TABLE IF NOT EXISTS ip_velocity_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address      inet NOT NULL,
  event_type      text NOT NULL CHECK (event_type IN ('micro_deposit_initiate', 'micro_deposit_confirm')),
  bank_account_id uuid REFERENCES bank_accounts(id),
  success         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ip_velocity_events_ip_created_idx ON ip_velocity_events(ip_address, created_at);
CREATE INDEX IF NOT EXISTS ip_velocity_events_account_created_idx ON ip_velocity_events(bank_account_id, created_at);

-- 6. Micro-Entry Fraud Alerts Table
CREATE TABLE IF NOT EXISTS micro_entry_fraud_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id uuid REFERENCES bank_accounts(id),
  ip_address      inet,
  alert_type      text NOT NULL CHECK (alert_type IN ('excessive_cycles', 'velocity_spike', 'repeated_failures', 'elevated_returns', 'suspicious_routing')),
  severity        text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  details         jsonb NOT NULL,
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  resolved_by     uuid REFERENCES users(id),
  resolved_at     timestamptz,
  resolution_note text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_alert_target CHECK (bank_account_id IS NOT NULL OR ip_address IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS micro_entry_fraud_alerts_bank_account_idx ON micro_entry_fraud_alerts(bank_account_id);
CREATE INDEX IF NOT EXISTS micro_entry_fraud_alerts_ip_idx ON micro_entry_fraud_alerts(ip_address);
CREATE INDEX IF NOT EXISTS micro_entry_fraud_alerts_status_idx ON micro_entry_fraud_alerts(status);

-- 7. Audit Log Immutability Protection (Function, Row-Level & Statement-Level Triggers)
CREATE OR REPLACE FUNCTION audit_logs_reject_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SECURITY VIOLATION: audit_logs is an immutable append-only ledger. UPDATE, DELETE, and TRUNCATE operations are prohibited.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_row_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_row_immutable
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW
EXECUTE FUNCTION audit_logs_reject_mutation();

DROP TRIGGER IF EXISTS trg_audit_logs_stmt_truncate ON audit_logs;
CREATE TRIGGER trg_audit_logs_stmt_truncate
BEFORE TRUNCATE ON audit_logs
FOR EACH STATEMENT
EXECUTE FUNCTION audit_logs_reject_mutation();
