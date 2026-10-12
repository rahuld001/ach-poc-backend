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
  status             text NOT NULL CHECK (status IN ('submitted', 'processed', 'rejected')),
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
  status          text NOT NULL CHECK (status IN ('pending', 'submitted', 'settled', 'returned', 'cancelled', 'failed')),
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
