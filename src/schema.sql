-- Applied automatically on server start (idempotent).

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

-- Customer authorization ("mandate") captured before each transfer. Nacha requires keeping these 2 years.
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
  status             text NOT NULL,
  process_after      timestamptz NOT NULL,
  processed_at       timestamptz,
  bank_response      jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transfers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id),
  mandate_id      uuid NOT NULL REFERENCES mandates(id),
  direction       text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_cents    int NOT NULL CHECK (amount_cents > 0),
  description     text,
  sec_code        char(3) NOT NULL,
  status          text NOT NULL,
  trace_number    char(15) UNIQUE,
  ach_file_id     uuid REFERENCES ach_files(id),
  effective_date  date,
  return_code     char(3),
  return_reason   text,
  idempotency_key text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transfers_status_idx ON transfers(status);
CREATE INDEX IF NOT EXISTS transfers_account_idx ON transfers(bank_account_id, created_at);

-- Audit trail of every status change.
CREATE TABLE IF NOT EXISTS transfer_events (
  id          bigserial PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES transfers(id),
  status      text NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS trace_seq;
-- Trace numbers the simulated receiving banks put on return / NOC entries.
CREATE SEQUENCE IF NOT EXISTS rdfi_trace_seq;

-- Which rail sends the transfer: 'mock' (our NACHA file to the simulated ODFI) or 'increase' (Increase ACH API).
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS rail text NOT NULL DEFAULT 'mock' CHECK (rail IN ('mock', 'increase'));
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS provider_transfer_id text UNIQUE;

-- Simulated go-live onboarding (KYB, KYC, provider underwriting, compliance, funding). One row, JSON state.
CREATE TABLE IF NOT EXISTS onboarding (
  id         int PRIMARY KEY CHECK (id = 1),
  state      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Simulated verification results: customer identity / sanctions / account status (per account) and pre-payment risk checks.
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS kyc jsonb;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS risk jsonb;

-- --- Direct ACH: bank handshake -----------------------------------------------------------------------------------

-- Transfer lifecycle: pending (not yet in a file) -> submitted (in a file sent to the ODFI) -> accepted (file
-- acknowledged by the ODFI) -> settled (effective date reached). returned / cancelled / failed are terminal.
ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_status_check;
ALTER TABLE transfers ADD CONSTRAINT transfers_status_check
  CHECK (status IN ('pending', 'submitted', 'accepted', 'settled', 'returned', 'cancelled', 'failed'));

-- What the entry is for: a customer payment, the micro-deposits that verify an account, or a reversal of an
-- erroneous entry (same SEC code as the original, entry description REVERSAL, within 5 banking days).
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'payment'
  CHECK (purpose IN ('payment', 'micro_deposit', 'reversal'));
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS reverses_transfer_id uuid REFERENCES transfers(id);
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS reversed_by_transfer_id uuid REFERENCES transfers(id);
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS settled_at timestamptz;
-- Debits can still come back as R01-type returns for 2 banking days after settlement (60 days for unauthorized).
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS return_window_ends date;

-- Files: 'origination' goes to the ODFI; 'return' comes back from it (returns and notifications of change).
-- Origination status: submitted -> accepted -> settled, or rejected. Inbound status: received -> applied.
ALTER TABLE ach_files DROP CONSTRAINT IF EXISTS ach_files_status_check;
ALTER TABLE ach_files ADD CONSTRAINT ach_files_status_check
  CHECK (status IN ('submitted', 'accepted', 'settled', 'processed', 'rejected', 'received', 'applied'));
ALTER TABLE ach_files ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'origination' CHECK (kind IN ('origination', 'return'));
ALTER TABLE ach_files ADD COLUMN IF NOT EXISTS file_name text;
ALTER TABLE ach_files ADD COLUMN IF NOT EXISTS transport text; -- mock | sftp | upload
ALTER TABLE ach_files ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
ALTER TABLE ach_files ADD COLUMN IF NOT EXISTS settles_at timestamptz;
ALTER TABLE ach_files ADD COLUMN IF NOT EXISTS effective_date date;

-- Simulated operating account: the money the business moves. Payouts hold funds until they settle; collections
-- post when they settle; returns take the money back plus the bank's return fee. Nothing here is real money.
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

-- People who sign in (required in live mode). Roles: admin, operator, viewer.
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text,
  role          text NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  password_hash text NOT NULL,
  disabled      boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Notifications of change (C01..C07) applied to an account, and any other account data corrections.
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
