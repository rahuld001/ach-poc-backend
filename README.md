# ACH Payments POC – Backend

Node.js API for the ACH Payments proof of concept (test mode, no real money). It links bank accounts (Plaid sandbox
or manual entry with micro-deposits), creates ACH debits and credits, writes real-format NACHA files and runs a
mock bank that settles or returns each payment.

The web UI lives in a separate repository (`ach-poc-web`).

## Stack
- Node.js 24 (ES modules), Express 5
- PostgreSQL 13+ via `pg` (tested on 17)
- `plaid` SDK for sandbox bank linking
- Built-in `node:crypto` (AES-256-GCM encryption at rest) and `node:test`

## Run locally
```bash
# 1. Create the database (the tables are created automatically on start)
psql -U postgres -c "CREATE DATABASE ach_poc"

# 2. Install and configure
npm install
cp .env.example .env     # set DATABASE_URL, API_KEY, ENCRYPTION_KEY (and Plaid keys if you have them)

# 3. Start
npm run dev              # http://localhost:4000, restarts on file changes
npm test                 # NACHA builder/parser and routing checksum tests
```
Check it's up: `curl http://localhost:4000/api/health` returns `{"ok":true}`.

## Configuration (`.env`)
| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 4000) |
| `API_KEY` | Secret key clients send as `Authorization: Bearer …`. A `sk_test_` prefix puts the app in test mode |
| `DATABASE_URL` | PostgreSQL connection string |
| `ENCRYPTION_KEY` | Long random string used to encrypt account numbers and Plaid tokens |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | Plaid sandbox keys. Leave blank to use manual entry only |
| `ODFI_ROUTING`, `ODFI_NAME`, `COMPANY_NAME`, `COMPANY_ID` | Originator details written into the NACHA file |
| `BATCH_INTERVAL_SECONDS` | How often pending payments are batched (0 = manual only) |
| `MOCK_BANK_DELAY_SECONDS` | Delay before the mock bank processes a file |
| `MAX_TRANSFER_CENTS`, `DAILY_LIMIT_CENTS` | Per-payment and per-account daily limits |

Never commit `.env`; it is ignored by git.

## How it works
1. **Link**: Plaid sandbox (instantly verified) or manual entry checked with the routing-number checksum and two
   simulated micro-deposits.
2. **Authorize**: the customer's authorization text, IP address and timestamp are stored as a mandate.
3. **Create**: debits use SEC code WEB, credits PPD. Idempotency key, per-payment and daily limits.
4. **Batch**: pending payments are written into a NACHA file (94-character records, entry hash, control totals,
   padded to blocks of 10).
5. **Mock bank**: parses and validates the file, then settles or returns each entry based on the account number.
6. **Returns**: R01, R02, R03, R10… Codes that require it (R02, R03, R04, R07, R10, R16, R29) disable the account.

Payment statuses: `pending → submitted → settled`, plus `returned`, `cancelled` and `failed`. Every change is
written to the `transfer_events` audit table.

## Project layout
| Path | Contents |
|---|---|
| `src/index.js` | Express app, API key auth, background batcher and mock bank timers |
| `src/schema.sql` | Database schema (applied on start, safe to re-run) |
| `src/nacha.js` | NACHA file builder and parser |
| `src/ach.js` | Routing checksum, return codes, test outcomes, SEC and transaction codes |
| `src/crypto.js` | AES-256-GCM encrypt/decrypt |
| `src/plaid.js` | Plaid client |
| `src/routes/` | `accounts`, `transfers`, `achFiles`, `sandbox` (test-mode simulations) |
| `src/services/` | `batcher`, `mockBank`, `transfers` (status changes + audit trail) |
| `test/` | Unit tests |

## API
All routes except `/api/health` need `Authorization: Bearer <API_KEY>`.
```
GET    /api/config
GET    /api/accounts                  POST /api/accounts            (manual)
POST   /api/accounts/:id/verify       DELETE /api/accounts/:id
POST   /api/accounts/plaid/link-token POST /api/accounts/plaid/exchange
GET    /api/transfers                 POST /api/transfers           (Idempotency-Key header)
GET    /api/transfers/:id             POST /api/transfers/:id/cancel
GET    /api/ach-files                 POST /api/ach-files/run
GET    /api/ach-files/:id             GET  /api/ach-files/:id/download
POST   /api/sandbox/transfers/:id/settle
POST   /api/sandbox/transfers/:id/return   { "return_code": "R01" }
POST   /api/sandbox/process-bank
```

## Test data
| Account number ending | Mock bank result |
|---|---|
| `0001` | Returned R01 Insufficient funds |
| `0002` | Returned R02 Account closed |
| `0003` | Returned R03 No account |
| `0010` | Returned R10 Not authorized |
| anything else | Settles |

Valid test routing numbers: `011401533`, `021000021`. Plaid sandbox login: `user_good` / `pass_good`.

## Deploying on Vercel
`src/index.js` exports the Express app, which Vercel runs as a serverless function.
1. Add a Postgres database (Storage tab → Neon) so `DATABASE_URL` is set, plus `API_KEY` and `ENCRYPTION_KEY`.
2. Turn off **Deployment Protection → Vercel Authentication** so the UI can call the API.
3. Use the production URL (for example `https://ach-poc-backend.vercel.app`) as the UI's `VITE_API_URL`.

Serverless functions have no background timers, so on Vercel the batcher and mock bank run during incoming API
requests instead. The UI polls every few seconds, so payments still progress while it is open. Tables are created on
the first request, and `/api/health` answers even when the database is unreachable (other routes return 503).

## Going to production
Replace `src/services/mockBank.js` with delivery to a real bank (SFTP with PGP, or the bank's ACH API) and add
processing of the bank's return and NOC files.
