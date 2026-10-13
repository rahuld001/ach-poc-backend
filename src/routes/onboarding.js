// Go-live onboarding, simulated: the steps a business goes through before it can move real money over ACH
// (KYB, KYC, bank/provider underwriting, compliance, funding, live keys). Every decision is made by a fake
// reviewer after a short delay, using test inputs to produce approvals, requests for info or rejections.
// Nothing here contacts a real bank, credit bureau or sanctions list.
import crypto from 'node:crypto';
import { Router } from 'express';
import { query } from '../db.js';
import { HttpError } from '../services/transfers.js';

const router = Router();

export const STEPS = ['business', 'owner', 'provider', 'compliance', 'funding', 'live'];
const REVIEW_SECONDS = { business: 6, owner: 5, provider: 8, compliance: 3, funding: 5, live: 4 };

const COMPLIANCE_ITEMS = [
  'nacha_agreement', 'authorization_language', 'account_validation', 'return_monitoring',
  'ofac_screening', 'data_security', 'privacy_policy',
];

const check = (label, ok, detail) => ({ label, ok, detail });
const required = (data, fields) => {
  const missing = fields.filter((f) => !String(data?.[f] ?? '').trim());
  if (missing.length) throw new HttpError(400, `Missing: ${missing.join(', ')}`);
};
const isSanctioned = (name) => /ofac\s*test/i.test(name ?? '');

// Input checks run on submit (instant), so obvious typos never go "into review".
const VALIDATE = {
  business: (d) => {
    required(d, ['legal_name', 'ein', 'entity_type', 'address', 'website', 'description']);
    // An EIN is 9 digits; accept it with or without the dash and store it as 12-3456789.
    const digits = String(d.ein).replace(/\D/g, '');
    if (digits.length !== 9) throw new HttpError(400, 'EIN must be 9 digits (for example 12-3456789)');
    d.ein = `${digits.slice(0, 2)}-${digits.slice(2)}`;
  },
  owner: (d) => {
    required(d, ['full_name', 'dob', 'ssn_last4', 'address', 'title', 'ownership_pct']);
    if (!/^\d{4}$/.test(d.ssn_last4)) throw new HttpError(400, 'SSN last 4 must be 4 digits');
    const pct = Number(d.ownership_pct);
    if (!(pct > 0 && pct <= 100)) throw new HttpError(400, 'Ownership must be between 1 and 100%');
  },
  provider: (d) => {
    required(d, ['provider', 'monthly_volume_usd', 'avg_payment_usd', 'max_payment_usd']);
    if (!['increase', 'bank'].includes(d.provider)) throw new HttpError(400, 'provider must be increase or bank');
    for (const f of ['monthly_volume_usd', 'avg_payment_usd', 'max_payment_usd']) {
      if (!(Number(d[f]) > 0)) throw new HttpError(400, `${f} must be a positive number`);
    }
  },
  compliance: (d) => {
    const unchecked = COMPLIANCE_ITEMS.filter((k) => !d?.[k]);
    if (unchecked.length) throw new HttpError(400, `All items must be confirmed (${unchecked.length} left)`);
  },
  funding: (d) => {
    required(d, ['amount_usd', 'method']);
    if (!(Number(d.amount_usd) > 0)) throw new HttpError(400, 'Amount must be positive');
  },
  live: () => {},
};

// The simulated reviewer. Returns { status, checks, notes, terms? }.
const DECIDE = {
  business: (d) => {
    const einMismatch = d.ein === '00-0000000';
    const needsDocs = d.ein.endsWith('9999');
    const checks = [
      check('EIN matches IRS records', !einMismatch, einMismatch ? 'Name/EIN combination not found' : 'IRS TIN match: confirmed'),
      check('Entity in good standing (Secretary of State)', true, `${d.entity_type} registered, status active`),
      check('Business address verified', true, 'Commercial address, not a mail drop'),
      check('Business sanctions screen (OFAC)', !isSanctioned(d.legal_name), isSanctioned(d.legal_name) ? 'Possible SDN list match' : 'No match'),
      check('Website and business model review', true, `${d.website} reviewed: permitted business`),
      check('Supporting documents on file', !needsDocs, needsDocs ? 'Formation documents and EIN letter missing' : 'Not required for this profile'),
    ];
    if (einMismatch || isSanctioned(d.legal_name)) return { status: 'rejected', checks, notes: ['The business could not be verified.'] };
    if (needsDocs) return { status: 'needs_info', checks, notes: ['Upload Articles of Incorporation and an IRS EIN letter (CP 575).'] };
    return { status: 'approved', checks, notes: ['Business verified (KYB).'] };
  },

  owner: (d) => {
    const age = (Date.now() - Date.parse(d.dob)) / (365.25 * 864e5);
    const sanctioned = isSanctioned(d.full_name);
    const idFail = d.ssn_last4 === '0000';
    const checks = [
      check('Identity verified (name, DOB, SSN)', !idFail, idFail ? 'Credit bureau header data does not match' : 'Matched 3 of 3 data sources'),
      check('Age 18 or over', age >= 18, `${Math.floor(age)} years old`),
      check('Residential address verified', true, 'Matched to bureau address history'),
      check('Sanctions screen (OFAC SDN list)', !sanctioned, sanctioned ? 'Potential match on SDN list' : 'No match'),
      check('Politically exposed person (PEP) screen', true, 'No match'),
    ];
    if (sanctioned || age < 18) return { status: 'rejected', checks, notes: ['The beneficial owner did not pass screening.'] };
    if (idFail) return { status: 'needs_info', checks, notes: ['Upload a government photo ID (front and back) and a selfie.'] };
    return { status: 'approved', checks, notes: ['Beneficial owner verified (KYC / CIP).'] };
  },

  provider: (d) => {
    const volume = Number(d.monthly_volume_usd);
    const max = Number(d.max_payment_usd);
    const bank = d.provider === 'bank';
    const checks = [
      check('Use case and SEC codes supported', true, 'WEB debits, PPD credits'),
      check('Projected volume within appetite', volume <= 5_000_000, `$${volume.toLocaleString()} / month`),
      check('Expected return rate under Nacha thresholds', true, 'Unauthorized < 0.5%, administrative < 3%, overall < 15%'),
      check('Exposure limit set', true, `Max single payment $${max.toLocaleString()}`),
    ];
    if (volume > 5_000_000) {
      return { status: 'needs_info', checks, notes: ['Volume above $5M/month: provide 2 years of financial statements and a processing history.'] };
    }
    const dailyLimit = Math.ceil((volume / 21) * 1.5);
    const reserve = Math.max(5_000, Math.round(volume * 0.1));
    return {
      status: 'approved',
      checks,
      notes: [bank ? 'Approved by the originating bank (ODFI) for direct NACHA origination.' : 'Approved by Increase for ACH origination through its partner bank.'],
      terms: {
        partner: bank ? 'First Simulated Bank, N.A. (ODFI)' : 'Increase (partner bank: Simulated Bank, N.A.)',
        delivery: bank ? 'NACHA files over SFTP with PGP, 4 cut-offs/day' : 'REST API + webhooks',
        daily_origination_limit_usd: dailyLimit,
        reserve_required_usd: reserve,
        settlement: 'Next business day; Same Day ACH available',
        pricing: bank ? '$0.20 per entry, $2.50 per return' : '$0.25 per entry, $2.00 per return',
      },
    };
  },

  compliance: () => ({
    status: 'approved',
    checks: [
      check('Nacha origination agreement signed', true, 'Agreement on file'),
      check('Customer authorization language approved', true, 'Stored per payment with IP and timestamp (mandates table)'),
      check('Account validation for WEB debits', true, 'Plaid Auth or micro-deposit verification'),
      check('Return rate monitoring', true, 'Returns tracked per account; R02/R03/R10… disable the account'),
      check('OFAC screening program', true, 'Screen names at onboarding and before each payout'),
      check('Data security', true, 'Account numbers encrypted at rest (AES-256-GCM), only last 4 shown'),
      check('Privacy policy and customer disclosures', true, 'Published'),
    ],
    notes: ['Compliance controls attested. An annual Nacha Rules compliance audit is due each year by December 31.'],
  }),

  funding: (d, state) => {
    const needed = state.steps.provider?.decision?.terms?.reserve_required_usd ?? 5_000;
    const amount = Number(d.amount_usd);
    const ok = amount >= needed;
    const ref = `20261013MMQFMP${crypto.randomInt(100000, 999999)}`;
    return {
      status: ok ? 'approved' : 'needs_info',
      checks: [
        check(`${d.method === 'wire' ? 'Fedwire' : 'ACH credit'} received`, true, `${d.method === 'wire' ? 'IMAD' : 'Trace'} ${ref}`),
        check('Reserve requirement met', ok, `Received $${amount.toLocaleString()}, required $${needed.toLocaleString()}`),
      ],
      notes: [ok ? 'Operating account funded. This balance covers payouts and returned debits.' : `Send at least $${(needed - amount).toLocaleString()} more to meet the reserve.`],
      balance_usd: amount,
    };
  },

  live: (_d, state) => ({
    status: 'approved',
    checks: [
      check('All onboarding steps approved', STEPS.slice(0, -1).every((s) => state.steps[s]?.status === 'approved'), 'KYB, KYC, provider, compliance, funding'),
      check('Live API key issued', true, `sk_live_••••${crypto.randomBytes(2).toString('hex')} (simulated, not usable)`),
      check('Webhook endpoint registered', true, 'https://ach-poc-backend.vercel.app/webhooks/ach (simulated)'),
      check('Test-to-live checklist', true, 'Remove sandbox endpoints, rotate secrets, enable monitoring'),
    ],
    notes: ['Ready to go live. In production you would now set the live keys in the backend and switch INCREASE_BASE_URL to https://api.increase.com.'],
  }),
};

const emptyState = () => ({ steps: Object.fromEntries(STEPS.map((s) => [s, { status: 'not_started' }])) });

async function load() {
  const { rows: [row] } = await query('SELECT state FROM onboarding WHERE id = 1');
  return row?.state ?? emptyState();
}
const save = (state) =>
  query(
    `INSERT INTO onboarding (id, state, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [state],
  );

// Finishes any review whose time is up. Called on every read, so it also works on serverless hosts.
function resolveReviews(state) {
  let changed = false;
  for (const name of STEPS) {
    const step = state.steps[name];
    if (step.status === 'in_review' && Date.now() >= Date.parse(step.review_until)) {
      const decision = DECIDE[name](step.data, state);
      Object.assign(step, { status: decision.status, decision, decided_at: new Date().toISOString() });
      changed = true;
    }
  }
  return changed;
}

router.get('/', async (_req, res) => {
  const state = await load();
  if (resolveReviews(state)) await save(state);
  res.json({ ...state, order: STEPS, review_seconds: REVIEW_SECONDS });
});

router.post('/:step', async (req, res) => {
  const name = req.params.step;
  if (!STEPS.includes(name)) throw new HttpError(404, 'Unknown onboarding step');
  const state = await load();
  resolveReviews(state);
  const previous = STEPS.slice(0, STEPS.indexOf(name)).find((s) => state.steps[s].status !== 'approved');
  if (previous) throw new HttpError(409, `Finish the "${previous}" step first`);
  if (['in_review', 'approved'].includes(state.steps[name].status)) {
    throw new HttpError(409, `This step is already ${state.steps[name].status.replace('_', ' ')}`);
  }
  const data = req.body ?? {};
  VALIDATE[name](data);
  state.steps[name] = {
    status: 'in_review',
    data,
    submitted_at: new Date().toISOString(),
    review_until: new Date(Date.now() + REVIEW_SECONDS[name] * 1000).toISOString(),
  };
  await save(state);
  res.json({ ...state, order: STEPS, review_seconds: REVIEW_SECONDS });
});

router.delete('/', async (_req, res) => {
  await save(emptyState());
  res.status(204).end();
});

export default router;
