import 'dotenv/config'; // must stay first: other modules read process.env on import
import { API_KEY, ORIGINATOR, SIM, isTestMode } from './config.js'; // second: validates the environment before anything else loads
import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { plaidEnabled } from './plaid.js';
import { AUTHORIZATION_TEMPLATES, NOC_CODES, RETURN_CODES, TEST_ACCOUNT_OUTCOMES, TEST_NOC_OUTCOMES } from './ach.js';
import { runBatch } from './services/batcher.js';
import { runOdfiJobs, transportName } from './services/odfi/index.js';
import { increaseEnabled, increaseSandbox, sendPendingToIncrease, syncIncrease } from './services/increase.js';
import accounts from './routes/accounts.js';
import transfers from './routes/transfers.js';
import achFiles from './routes/achFiles.js';
import sandbox from './routes/sandbox.js';
import onboarding from './routes/onboarding.js';

const app = express();
// Behind Vercel's proxy, so req.ip (stored on each mandate as evidence of who authorized the payment) is the client.
if (process.env.VERCEL) app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '2mb' })); // inbound NACHA files are posted as text

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Create the tables on first use rather than at import time, so a database problem returns an error
// instead of crashing the process (on serverless hosts that would fail every request, even /health).
let dbReady;
app.use('/api', async (_req, res, next) => {
  try {
    await (dbReady ??= initDb());
    next();
  } catch (err) {
    dbReady = undefined; // retry on the next request
    console.error('[db]', err.message);
    res.status(503).json({ error: `Database unavailable: ${err.message}` });
  }
});

// API key auth (mimics provider-style secret keys).
app.use('/api', (req, res, next) => {
  const token = req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token || token !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  next();
});

// Serverless stand-in for the timers below: run any job that is due before handling the request. The UI polls
// every few seconds, so payments still move pending → submitted → accepted → settled on their own while it is open.
if (process.env.VERCEL) {
  const lastRun = new Map();
  app.use('/api', async (_req, _res, next) => {
    for (const job of JOBS.filter((j) => j.seconds > 0 && Date.now() - (lastRun.get(j.name) ?? 0) >= j.seconds * 1000)) {
      lastRun.set(job.name, Date.now());
      await job.fn().catch((e) => console.error(`[${job.name}]`, e.message));
    }
    next();
  });
}

app.get('/api/config', (_req, res) =>
  res.json({
    mode: isTestMode ? 'test' : 'live',
    authorization_templates: AUTHORIZATION_TEMPLATES,
    direct_ach: {
      transport: transportName,
      odfi_name: ORIGINATOR.odfiName,
      odfi_routing: ORIGINATOR.odfiRouting,
      company_name: ORIGINATOR.companyName,
      company_id: ORIGINATOR.companyId,
      line_ending: ORIGINATOR.lineEnding,
      balanced: ORIGINATOR.balanced,
    },
    simulation: { banking_day_seconds: SIM.bankingDaySeconds, ack_seconds: SIM.ackSeconds },
    plaid_enabled: plaidEnabled,
    rails: { mock: true, increase: increaseEnabled },
    increase_env: increaseEnabled ? (increaseSandbox ? 'sandbox' : 'production') : null,
    return_codes: RETURN_CODES,
    noc_codes: NOC_CODES,
    test_account_outcomes: TEST_ACCOUNT_OUTCOMES,
    test_noc_outcomes: TEST_NOC_OUTCOMES,
    limits: {
      max_transfer_cents: Number(process.env.MAX_TRANSFER_CENTS ?? 1_000_000),
      daily_limit_cents: Number(process.env.DAILY_LIMIT_CENTS ?? 2_500_000),
    },
    batch_interval_seconds: Number(process.env.BATCH_INTERVAL_SECONDS ?? 60),
    mock_bank_delay_seconds: Number(process.env.MOCK_BANK_DELAY_SECONDS ?? 15),
  }),
);

app.use('/api/accounts', accounts);
app.use('/api/transfers', transfers);
app.use('/api/ach-files', achFiles);
if (isTestMode) app.use('/api/sandbox', sandbox); // simulation endpoints do not exist in live mode
app.use('/api/onboarding', onboarding);

app.use((err, _req, res, _next) => {
  if (err.status) return res.status(err.status).json({ error: err.message, ...(err.details && { details: err.details }) });
  if (err.code === '22P02') return res.status(400).json({ error: 'Invalid id' }); // bad uuid
  if (err.code === '23505') return res.status(409).json({ error: 'Duplicate request' });
  console.error(err);
  res.status(500).json({ error: err.response?.data?.error_message || 'Internal server error' });
});

const JOBS = [
  { name: 'batcher', seconds: Number(process.env.BATCH_INTERVAL_SECONDS ?? 60), fn: runBatch },
  { name: 'odfi', seconds: 3, fn: runOdfiJobs }, // acknowledgments, settlement, returns and NOCs from the bank
  { name: 'increase-send', seconds: Number(process.env.BATCH_INTERVAL_SECONDS ?? 60), fn: sendPendingToIncrease },
  { name: 'increase-sync', seconds: 5, fn: syncIncrease },
];

// Express on Vercel runs as a serverless function: no long-lived process, so no timers. Export the app for it,
// and only listen and start timers when running as a normal server.
export default app;

if (!process.env.VERCEL) {
  await (dbReady ??= initDb());
  for (const job of JOBS.filter((j) => j.seconds > 0)) {
    setInterval(() => job.fn().catch((e) => console.error(`[${job.name}]`, e.message)), job.seconds * 1000);
  }
  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, () =>
    console.log(`ACH POC API on http://localhost:${port} (ODFI transport: ${transportName}, plaid: ${plaidEnabled ? 'on' : 'off'})`),
  );
}
