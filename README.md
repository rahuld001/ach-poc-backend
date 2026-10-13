# ACH Payments POC – Backend

Node.js API for a **direct ACH** proof of concept: no payment gateway or third-party processor. The application is
the Originator, it exchanges NACHA files with its bank (the ODFI), and money moves bank to bank over the ACH network.
Everything a real originator does is here: account verification by micro-deposits, customer authorizations
(mandates), NACHA file origination, bank acknowledgment, settlement on the effective date, return files, notifications
of change, reversals and Nacha return-rate monitoring.

In test mode the bank is simulated **in this process** on a compressed clock, so a full ACH cycle (file sent →
acknowledged → settled → returned) plays out in under a minute with real NACHA files in both directions. Switch
`ODFI_TRANSPORT` to `sftp` and the same code talks to a real ODFI drop folder.

Plaid (instant account linking) and Increase (ACH-as-an-API) are optional extras, hidden from the UI unless configured.
The web UI lives in a separate repository (`ach-poc-web`).

## Stack
- Node.js 24 (ES modules), Express 5
- PostgreSQL 13+ via `pg` (tested on 17)
- Built-in `node:crypto` (AES-256-GCM encryption at rest) and `node:test`
- Optional: `plaid` SDK, `ssh2-sftp-client` (only for `ODFI_TRANSPORT=sftp`)

## Run locally
```bash
# 1. Create the database (the tables are created automatically on start)
psql -U postgres -c "CREATE DATABASE ach_poc"

# 2. Install and configure
npm install
cp .env.example .env     # set DATABASE_URL, API_KEY, ENCRYPTION_KEY

# 3. Start
npm run dev              # http://localhost:4000, restarts on file changes
npm test                 # NACHA builder/parser, return/NOC files, banking-day calendar, authorization text
```
Check it's up: `curl http://localhost:4000/api/health` returns `{"ok":true}`.

## Configuration (`.env`)
| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 4000) |
| `API_KEY` | Secret key clients send as `Authorization: Bearer …`. A `sk_test_` prefix puts the app in test mode; any other key is live mode |
| `DATABASE_URL` | PostgreSQL connection string |
| `ENCRYPTION_KEY` | Random string used to encrypt account numbers, Plaid tokens and NACHA file contents. Required (32+ chars) in live mode |
| `ODFI_ROUTING`, `ODFI_NAME`, `COMPANY_NAME`, `COMPANY_ID` | Originator details written into every NACHA file |
| `ODFI_TRANSPORT` | `mock` (simulated bank, default) or `sftp` (real ODFI drop folder, see below) |
| `ACH_LINE_ENDING` | `LF` (default) or `CRLF`, whichever the ODFI's origination guide asks for |
| `ACH_BALANCED`, `COMPANY_ROUTING_NUMBER`, `COMPANY_ACCOUNT_NUMBER` | `true` adds an offsetting entry to your own account so each batch nets to zero (some ODFIs require balanced files) |
| `BATCH_INTERVAL_SECONDS` | How often pending entries are written into a file (0 = manual only) |
| `SIM_BANKING_DAY_SECONDS`, `SIM_ACK_SECONDS` | Simulated bank clock: length of a banking day (default 20s) and acknowledgment delay (default 5s) |
| `MAX_TRANSFER_CENTS`, `DAILY_LIMIT_CENTS` | Per-payment and per-account daily limits |
| `SFTP_HOST`, `SFTP_PORT`, `SFTP_USERNAME`, `SFTP_PASSWORD` / `SFTP_PRIVATE_KEY`, `SFTP_OUTBOUND_DIR`, `SFTP_INBOUND_DIR`, `SFTP_PROCESSED_DIR` | Bank SFTP details for `ODFI_TRANSPORT=sftp` |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | Optional Plaid sandbox keys. Blank = direct ACH only |
| `INCREASE_API_KEY`, `INCREASE_BASE_URL`, `INCREASE_ACCOUNT_ID` | Optional Increase rail. Blank = direct ACH only |

Never commit `.env`; it is ignored by git.

### Test mode vs live mode
`src/config.js` checks the environment at startup. With an `sk_test_` key the app is in **test mode**: the sandbox
endpoints exist, micro-deposit amounts are returned by the API so the demo can be driven, and a production Increase
URL is refused. With any other key it is **live mode**: `ENCRYPTION_KEY` must be a real random value (the server
refuses to start otherwise), `/api/sandbox/*` returns 404 and micro-deposit amounts are never revealed.

## The direct ACH flow
1. **Add a bank account.** Routing-number checksum, simulated identity / sanctions / account-status checks, and the
   customer authorizes the verification entries. Two micro-deposit credits and one offsetting debit are created as
   PPD entries (`ACCTVERIFY`), so verification uses the ACH network itself.
2. **File origination** (`src/services/batcher.js`). Pending entries become one NACHA file: one batch per SEC code and
   entry description (`PAYMENT` WEB debits with payment type code `S`, `PAYOUT` PPD credits, `ACCTVERIFY`,
   `REVERSAL`), trace numbers from the ODFI routing plus a sequence, entry hash and control totals, effective date =
   next banking day (weekends and Federal Reserve holidays skipped). The file is stored encrypted and handed to the
   transport. Entries are now `submitted`.
3. **Acknowledgment.** The ODFI validates the file and acknowledges or rejects it. Entries become `accepted` (or
   `failed`). The simulated bank runs the same validation the parser applies to inbound files.
4. **Settlement.** On the effective date every accepted entry becomes `settled`. Nobody reports this in direct ACH;
   it is inferred from the effective date, and debits remain returnable for 2 banking days
   (`return_window_ends`), 60 days for unauthorized returns.
5. **Verify the account.** Once the micro-deposit credits have settled the customer enters the two amounts (3 attempts,
   7 days). `GET /api/accounts` shows where the micro-deposits are.
6. **Returns and NOCs** (`src/services/inbound.js`). The bank's return file is parsed; each entry with a type-99 addenda
   is matched to our transfer by original trace number and marked `returned` (R02/R03/R04/R07/R10… also disable the
   account). Type-98 addenda in a `COR` batch are notifications of change: C01–C07 update the stored routing number,
   account number or account type and are logged in `account_changes`. Files can also be pasted through the API.
7. **Reversals.** A settled payment can be reversed within 5 banking days: an opposite entry in the same SEC code with
   entry description `REVERSAL`, no new authorization needed.
8. **Monitoring.** `GET /api/transfers/return-rates` reports the 60-day unauthorized, administrative and overall debit
   return rates against the Nacha thresholds (0.5%, 3%, 15%). Every status change is written to `transfer_events`.

Payment statuses: `pending → submitted → accepted → settled`, plus `returned`, `cancelled` and `failed`.
File statuses: origination `submitted → accepted → settled` (or `rejected`), inbound `received → applied`.

### The simulated bank (`src/services/odfi/mock.js`)
Plays the ODFI and every receiving bank on a compressed clock: acknowledgment after `SIM_ACK_SECONDS`, settlement
after one simulated banking day, then real NACHA return files based on the account number:

| Account number ending | What the receiving bank does |
|---|---|
| `0001` | Customer payment debits return **R01** Insufficient funds, 1 banking day after settlement |
| `0002` / `0003` / `0004` | Everything (micro-deposits included) returns **R02 / R03 / R04**; the account is disabled |
| `0010` | Customer payment debits return **R10** Not authorized, 3 banking days after settlement (late return) |
| `0005` | Settles, then **NOC C01**: corrected account number is applied |
| `0006` | Settles, then **NOC C02**: corrected routing number is applied |
| anything else | Settles |

Valid test routing numbers: `011401533`, `021000021`. `POST /api/sandbox/process-bank` ("Advance bank clock" in the
UI) runs acknowledgment, settlement and returns immediately.

### Going live: the SFTP transport (`src/services/odfi/sftp.js`)
`ODFI_TRANSPORT=sftp` uploads each origination file to the bank's outbound folder inside the batch transaction (a
failed upload leaves the entries pending for the next run), and polls the inbound folder for return / NOC files,
which go through the same `applyInboundFile` as the simulation. Marked `BANK-SPECIFIC` in the code and taken from
the ODFI's origination guide: PGP encryption of the file body, file naming, the acknowledgment file format, cut-off
times. Install the client with `npm install ssh2-sftp-client`.

## Project layout
| Path | Contents |
|---|---|
| `src/index.js` | Express app, API key auth, background jobs (batcher, bank side, Increase) |
| `src/config.js` | Test/live mode, originator details, simulation clock, startup checks |
| `src/schema.sql` | Database schema (applied on start, safe to re-run) |
| `src/nacha.js` | NACHA file builder and parser, including addenda (returns, NOCs) and masking |
| `src/ach.js` | Routing checksum, return and NOC codes, banking-day calendar, authorization templates |
| `src/crypto.js` | AES-256-GCM encrypt/decrypt |
| `src/routes/` | `accounts`, `transfers`, `achFiles`, `onboarding`, `sandbox` (test mode only) |
| `src/services/batcher.js` | Builds and delivers origination files |
| `src/services/odfi/` | Bank side: `index.js` (settlement, job runner), `mock.js` (simulated bank), `sftp.js` (real bank) |
| `src/services/inbound.js` | Applies return and NOC files |
| `src/services/verification.js` | Simulated KYC / sanctions / risk checks |
| `src/services/increase.js`, `src/plaid.js` | Optional third-party integrations |
| `test/` | Unit tests |

## API
All routes except `/api/health` need `Authorization: Bearer <API_KEY>`.
```
GET    /api/config
GET    /api/accounts                  POST /api/accounts            { ..., authorization: { accepted: true } }
POST   /api/accounts/:id/verify       DELETE /api/accounts/:id
GET    /api/transfers                 POST /api/transfers           (Idempotency-Key header)
GET    /api/transfers/:id             POST /api/transfers/:id/cancel
POST   /api/transfers/:id/reverse     GET  /api/transfers/return-rates
GET    /api/ach-files[?kind=origination|return]
POST   /api/ach-files/run             POST /api/ach-files/inbound   { content, file_name }
GET    /api/ach-files/:id             GET  /api/ach-files/:id/download
GET    /api/onboarding                POST /api/onboarding/:step    DELETE /api/onboarding
POST   /api/sandbox/transfers/:id/settle                            (test mode only)
POST   /api/sandbox/transfers/:id/return   { "return_code": "R01" }
POST   /api/sandbox/process-bank
POST   /api/accounts/plaid/link-token POST /api/accounts/plaid/exchange   (only with Plaid keys)
```
`GET /api/ach-files/:id` masks account numbers to their last 4 digits; only the download returns the file as
exchanged with the bank.

## Simulated verification and go-live
Real ACH systems buy these checks from vendors; here they are simulated (`src/services/verification.js`,
`src/routes/onboarding.js`) so every outcome can be demoed. Nothing external is called.

| Where | Checks | Test inputs |
|---|---|---|
| Adding a bank account (`dob`, `ssn_last4`, `address`) | Identity (name/DOB/SSN), age, address, OFAC sanctions, account status | SSN last 4 `0000` or name `OFAC Test` or under 18 → 422; account ending `0002`/`0003` → status warning |
| Every payment (`risk` on the transfer) | OFAC re-screen, Nacha account validation, identity, balance (debits), duplicates, velocity | …0001 → low-balance warning; same amount twice in 10 min → duplicate warning; sanctions hit → 422 blocked |
| Go Live (`/api/onboarding`) | KYB, owner KYC, bank underwriting, compliance, funding, live keys | EIN ending `9999` → needs documents; `00-0000000` → rejected; volume > 5M → needs financials |

## Deploying on Vercel
`src/index.js` exports the Express app, which Vercel runs as a serverless function.
1. Add a Postgres database (Storage tab → Neon) so `DATABASE_URL` is set, plus `API_KEY` and `ENCRYPTION_KEY`.
2. Turn off **Deployment Protection → Vercel Authentication** so the UI can call the API. The app trusts Vercel's
   proxy headers, so the client IP recorded on each mandate is the real one.
3. Use the production URL as the UI's `VITE_API_URL`.

Serverless functions have no background timers, so on Vercel the batcher and the bank side run during incoming API
requests instead. The UI polls every few seconds, so files still move while it is open.
