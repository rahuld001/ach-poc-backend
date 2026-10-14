// Background jobs: batching entries into files, the bank side (acknowledgments, settlement, returns) and the optional
// Increase rail. Run by the web process (default), by `npm run worker` on a separate process, or per request on Vercel.
import { query } from './db.js';
import { CUTOFFS } from './config.js';
import { isBankingDay } from './ach.js';
import { runBatch } from './services/batcher.js';
import { runOdfiJobs } from './services/odfi/index.js';
import { sendPendingToIncrease, syncIncrease } from './services/increase.js';

/** Wall-clock date and HH:MM in US Eastern, the time zone ACH cut-offs are quoted in. */
function eastern(d) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** True when a cut-off has passed today and no file has been sent since it. */
export async function cutoffDue(now = new Date()) {
  if (!CUTOFFS.length) return true;
  const et = eastern(now);
  const [y, m, d] = et.date.split('-').map(Number);
  if (!isBankingDay(new Date(y, m - 1, d))) return false;
  const passed = CUTOFFS.filter((c) => c <= et.time).at(-1);
  if (!passed) return false;
  const { rows: [last] } = await query(`SELECT max(created_at) AS at FROM ach_files WHERE kind = 'origination'`);
  if (!last?.at) return true;
  const lf = eastern(new Date(last.at));
  return lf.date !== et.date || lf.time < passed;
}

async function batchAtCutoff() {
  return (await cutoffDue()) ? runBatch() : null;
}

const interval = Number(process.env.BATCH_INTERVAL_SECONDS ?? 60);
export const JOBS = [
  // With cut-offs configured the batcher checks every 30 seconds and only sends at a cut-off.
  { name: 'batcher', seconds: CUTOFFS.length ? 30 : interval, fn: batchAtCutoff },
  { name: 'odfi', seconds: 3, fn: runOdfiJobs }, // acknowledgments, settlement, returns and NOCs from the bank
  { name: 'increase-send', seconds: interval, fn: sendPendingToIncrease },
  { name: 'increase-sync', seconds: 5, fn: syncIncrease },
];

/** Starts every job on its own timer. */
export function startJobs() {
  for (const job of JOBS.filter((j) => j.seconds > 0)) {
    let running = false; // never overlap runs of the same job
    setInterval(async () => {
      if (running) return;
      running = true;
      try { await job.fn(); } catch (e) { console.error(`[${job.name}]`, e.message); } finally { running = false; }
    }, job.seconds * 1000);
  }
}
