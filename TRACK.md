# ACH POC: Progress Tracker

Covers both repos: `ach-poc-backend` (Node/Express/Postgres) and `ach-poc-web` (React/Vite).
Update this file at the end of every work session (see "End-of-day checklist").

**Legend:** `[x]` done, `[~]` in progress, `[ ]` pending, `[!]` blocked

---

## Resume Here (read this first)

| | |
|---|---|
| **Last updated** | 2026-11-19 |
| **Current phase** | Phase 1 done. Phase 2 started: schema/migration groundwork (2a). |
| **Last thing done** | Added a migration runner, Phase 1 baseline + Phase 2 bank-verification migrations, and a Phase 2a schema integration test. `db.js` `initDb()` now runs migrations instead of `schema.sql`. |
| **Next action** | Run `npm test` (integration test needs a Postgres `DATABASE_URL`) and confirm `002_phase2_bank_verification.sql` applies and rolls back via `002_phase2_down.sql`. |
| **Blockers / open questions** | None known. Tests not yet run this session. |
| **Uncommitted work?** | Committed and pushed to `develop` in `ach-poc-backend`. `ach-poc-web` clean. |

> TRACK.md now lives in the `ach-poc-backend` repo so it is version controlled.

---

## Phase 0: Simulated ACH POC (baseline, done)
Source: git history of both repos.
- [x] Direct ACH flow: NACHA build/parse, batching, acknowledgment, settlement, returns, NOCs, reversals
- [x] Simulated ODFI bank (`services/odfi/mock.js`) on a compressed clock
- [x] Micro-deposit account verification, customer authorization text
- [x] Simulated KYC / OFAC / risk checks and Go Live onboarding
- [x] Simulated operating account (holds, settlement, return fees)
- [x] Optional rails: Plaid, Increase
- [x] Vercel serverless deployment (request-driven jobs)
- [x] Web UI: accounts, new payment, transactions, ACH files, Go Live
- [x] Simulated / Real environment switch, sign-in, roles, cut-off scheduling, worker, PGP groundwork

## Phase 1: Core foundation, security guards, atomic idempotency
Latest backend commit: `5288a75`. Confirm scope against it and fill in below.
- [x] Core foundation implemented (commit `5288a75`)
- [x] Security guards
- [x] Atomic idempotency for transfers
- [ ] Verify `npm test` passes in backend (`test/ach`, `inbound`, `nacha`)
- [ ] Web UI updated to match any Phase 1 API changes
- [ ] README updated for Phase 1 changes

## Phase 2: Bank readiness (from README "still open before real money moves")
Schema groundwork (2a):
- [x] Migration runner (`src/migrate.js`, `schema_migrations` table); `initDb()` uses it
- [x] `migrations/001_phase1_baseline.sql`
- [x] `migrations/002_phase2_bank_verification.sql` plus `002_phase2_down.sql`
- [x] Integration test `test/integration/phase2a_schema.test.js` written
- [ ] Integration test run and passing against a real Postgres
- [ ] Decide whether `src/schema.sql` is removed or kept in sync

Bank integration:
- [ ] Obtain ODFI origination guide
- [ ] Implement bank's acknowledgment file format (`services/odfi/sftp.js`, `BANK-SPECIFIC`)
- [ ] PGP file encryption, file naming, cut-off times per bank rules
- [ ] Bank certification / test-file exchange
- [ ] Real identity and sanctions provider (replace `services/verification.js` simulation)
- [ ] Daily reconciliation against the bank's statements

## Phase 3: Real environment deployment
- [ ] Separate real deployment and database (`API_KEY` live, `ENCRYPTION_KEY`, `SESSION_SECRET`)
- [ ] First admin user (`ADMIN_EMAIL` / `ADMIN_PASSWORD`), role review (admin / operator / viewer)
- [ ] Always-on worker (`RUN_JOBS=false` on API, `npm run worker`)
- [ ] Point UI `VITE_REAL_API_URL` at real backend
- [ ] Monitoring, alerting, return-rate thresholds (0.5% / 3% / 15%)

## Phase 4: Hardening and launch
- [ ] Security review (secrets, encryption at rest, access control)
- [ ] Pilot with low-value real transactions
- [ ] Go-live sign-off

---

## Session Log (newest first)

### 2026-11-19
- **Done:** Created TRACK.md. Committed Phase 2a migration work (runner, migrations 001/002, integration test) and pushed to `develop`.
- **Pending:** Run tests against Postgres; all bank-integration items in Phase 2.
- **Next steps:** `npm test` with `DATABASE_URL` set; verify the 002 up/down migrations.
- **Notes / decisions:** _(none)_

<!-- Copy the block above for each new session. -->

---

## End-of-day checklist
1. Run `git status` in `ach-poc-backend` and `ach-poc-web`; commit or note uncommitted work.
2. Run `npm test` in the backend; record the result.
3. Update **Resume Here** (last done, next action, blockers).
4. Tick completed boxes in the phases above; add newly discovered tasks.
5. Add a dated entry to the Session Log (done / pending / next steps / decisions).
