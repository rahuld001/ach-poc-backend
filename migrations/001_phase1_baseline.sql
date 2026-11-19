-- ============================================================
-- ACH POC – Migration 001: Phase 1 Baseline Schema (16 Tables)
-- ============================================================

CREATE TABLE IF NOT EXISTS plaid_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id          text NOT NULL UNIQUE,
  access_token_enc text NOT NULL,
  institution_name text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holder_name        text NOT NULL,
  institution_name   text,
  routing_number     char(9) NOT NULL,
  account_number_enc text NOT NULL,
  last4              char(4) NOT NULL,
  account_type       text NOT NULL CHECK (account_type IN ('checking', 'savings')),
  source             text NOT NULL CHECK (source IN ('plaid', 'manual')),
  plaid_item_id      uuid REFERENCES plaid_items(id),
  plaid_account_id   text UNIQUE,
  status             text NOT NULL CHECK (status IN ('pending_verification', 'verified', 'disabled')),
  disabled_reason    text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS micro_deposits (
  bank_account_id uuid PRIMARY KEY REFERENCES bank_accounts(id),
  amount1_cents   int NOT NULL,
  amount2_cents   int NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  expires_at      timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS mandates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id    uuid NOT NULL REFERENCES bank_accounts(id),
  authorization_text text NOT NULL,
  ip_address         text,
  user_agent         text,
  accepted_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ach_files (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id_modifier   char(1) NOT NULL,
  content            text NOT NULL,
  batch_count        int NOT NULL,
  entry_count        int NOT NULL,
  entry_hash         bigint NOT NULL,
  total_debit_cents  bigint NOT NULL,
  total_credit_cents bigint NOT NULL,
  status             text NOT NULL CHECK (status IN ('submitted', 'accepted', 'settled', 'processed', 'rejected', 'received', 'applied')),
  process_after      timestamptz NOT NULL,
  processed_at       timestamptz,
  bank_response      jsonb,
  kind               text NOT NULL DEFAULT 'origination' CHECK (kind IN ('origination', 'return')),
  file_name          text,
  transport          text,
  acknowledged_at    timestamptz,
  settles_at         timestamptz,
  effective_date     date,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transfers (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id         uuid NOT NULL REFERENCES bank_accounts(id),
  mandate_id              uuid NOT NULL REFERENCES mandates(id),
  direction               text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_cents            int NOT NULL CHECK (amount_cents > 0),
  description             text,
  sec_code                char(3) NOT NULL,
  status                  text NOT NULL CHECK (status IN ('pending', 'submitted', 'accepted', 'settled', 'returned', 'cancelled', 'failed')),
  trace_number            char(15) UNIQUE,
  ach_file_id             uuid REFERENCES ach_files(id),
  effective_date          date,
  return_code             char(3),
  return_reason           text,
  idempotency_key         text UNIQUE,
  rail                    text NOT NULL DEFAULT 'mock' CHECK (rail IN ('mock', 'increase')),
  provider_transfer_id    text UNIQUE,
  purpose                 text NOT NULL DEFAULT 'payment' CHECK (purpose IN ('payment', 'micro_deposit', 'reversal')),
  reverses_transfer_id    uuid REFERENCES transfers(id),
  reversed_by_transfer_id uuid REFERENCES transfers(id),
  settled_at              timestamptz,
  return_window_ends      date,
  risk                    jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transfers_status_idx ON transfers(status);
CREATE INDEX IF NOT EXISTS transfers_account_idx ON transfers(bank_account_id, created_at);

CREATE TABLE IF NOT EXISTS transfer_events (
  id          bigserial PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES transfers(id),
  status      text NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS trace_seq;
CREATE SEQUENCE IF NOT EXISTS rdfi_trace_seq;

CREATE TABLE IF NOT EXISTS onboarding (
  id         int PRIMARY KEY CHECK (id = 1),
  state      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS kyc jsonb;

CREATE TABLE IF NOT EXISTS operating_account (
  id            int PRIMARY KEY CHECK (id = 1),
  balance_cents bigint NOT NULL DEFAULT 0,
  held_cents    bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id            bigserial PRIMARY KEY,
  transfer_id   uuid REFERENCES transfers(id),
  type          text NOT NULL CHECK (type IN ('opening', 'funding', 'collection', 'payout', 'return', 'return_fee', 'reversal')),
  amount_cents  bigint NOT NULL,
  balance_after bigint NOT NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text,
  role          text NOT NULL CHECK (role IN ('admin', 'operator', 'viewer', 'approver')),
  password_hash text NOT NULL,
  disabled      boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_changes (
  id              bigserial PRIMARY KEY,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id),
  transfer_id     uuid REFERENCES transfers(id),
  change_code     char(3) NOT NULL,
  description     text NOT NULL,
  old_value       text,
  new_value       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name         text NOT NULL,
  nacha_company_id   char(10) NOT NULL UNIQUE,
  odfi_routing       char(9),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'underwriting')),
  created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id);
ALTER TABLE transfers     ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id);
ALTER TABLE ach_files     ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id);
CREATE INDEX IF NOT EXISTS bank_accounts_company_idx ON bank_accounts(company_id);
CREATE INDEX IF NOT EXISTS transfers_company_idx     ON transfers(company_id);

CREATE TABLE IF NOT EXISTS payment_approvals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id          uuid NOT NULL REFERENCES transfers(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  reviewed_by_user_id  uuid REFERENCES users(id),
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason     text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  decided_at           timestamptz,
  CONSTRAINT no_self_approval CHECK (requested_by_user_id IS DISTINCT FROM reviewed_by_user_id)
);
CREATE INDEX IF NOT EXISTS approvals_transfer_idx ON payment_approvals(transfer_id);
CREATE INDEX IF NOT EXISTS approvals_status_idx   ON payment_approvals(status);

CREATE TABLE IF NOT EXISTS idempotency_records (
  idempotency_key  text PRIMARY KEY,
  request_path     text NOT NULL,
  payload_hash     char(64) NOT NULL,
  response_status  int,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '72 hours'
);
CREATE INDEX IF NOT EXISTS idempotency_expires_idx ON idempotency_records(expires_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id   text,
  actor_id         uuid,
  actor_role       text,
  ip_address       text,
  action           text NOT NULL,
  resource_type    text NOT NULL,
  resource_id      text,
  company_id       uuid REFERENCES companies(id),
  previous_state   jsonb,
  new_state        jsonb,
  outcome          text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'failure', 'error')),
  metadata         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx     ON audit_logs(action);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx      ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS audit_logs_resource_idx   ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx    ON audit_logs(created_at);
