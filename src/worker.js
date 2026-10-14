// Standalone job runner for real-bank deployments: `npm run worker`. Run it as one always-on process (a container, a
// VM service) next to the API, and set RUN_JOBS=false on the API so only the worker sends files at the cut-offs.
import 'dotenv/config';
import './config.js';
import { initDb } from './db.js';
import { CUTOFFS } from './config.js';
import { startJobs } from './jobs.js';

await initDb();
startJobs();
console.log(`[worker] jobs running${CUTOFFS.length ? `; files sent at cut-offs ${CUTOFFS.join(', ')} ET` : ''}`);
