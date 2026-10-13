// Simulated verification checks that a live ACH system buys from vendors: identity (KYC) from a credit bureau or
// identity provider, OFAC sanctions screening, bank account status (e.g. Early Warning), balance checks (Plaid
// Balance). Nothing external is called; test inputs decide the outcome so every path can be demoed.

const check = (label, ok, detail, level = ok ? 'pass' : 'fail') => ({ label, ok, level, detail });
const warn = (label, detail) => ({ label, ok: true, level: 'warn', detail });

export const isSanctioned = (name) => /ofac\s*test/i.test(name ?? '');

// Account-status database result by last 4 digits (same test accounts the mock bank returns).
const ACCOUNT_STATUS = {
  '0002': 'Reported closed by the bank (high risk of R02)',
  '0003': 'No record of this account (high risk of R03)',
};
// Simulated available balance for debits; the …0001 test account is nearly empty.
const balanceFor = (last4) => (last4 === '0001' ? 1234 : 1_250_000);

/**
 * Customer identity (KYC) when a bank account is added. `result` is pass | fail | not_provided.
 * Test inputs: name "OFAC Test" → sanctions hit; SSN last 4 "0000" → identity mismatch; under 18 → fail.
 */
export function verifyCustomer({ holder_name, dob, ssn_last4, address, last4 }) {
  const checks = [check('Sanctions screen (OFAC SDN list)', !isSanctioned(holder_name),
    isSanctioned(holder_name) ? `Potential match for "${holder_name}"` : 'No match')];

  if (dob || ssn_last4 || address) {
    const age = (Date.now() - Date.parse(dob)) / (365.25 * 864e5);
    checks.unshift(
      check('Identity verified (name, DOB, SSN)', ssn_last4 !== '0000',
        ssn_last4 === '0000' ? 'Credit bureau records do not match' : 'Matched 3 of 3 data sources'),
      check('Age 18 or over', age >= 18, Number.isFinite(age) ? `${Math.floor(age)} years old` : 'Invalid date of birth'),
      check('Address verified', true, address),
    );
  }
  const status = ACCOUNT_STATUS[last4];
  checks.push(status ? warn('Bank account status', status) : check('Bank account status', true, 'Open and in good standing'));

  const failed = checks.some((c) => c.level === 'fail');
  const result = failed ? 'fail' : dob ? 'pass' : 'not_provided';
  return { result, checked_at: new Date().toISOString(), checks };
}

/** Plaid-linked accounts: identity comes from the bank login, so only screen the name. */
export function verifyPlaidCustomer(name) {
  return {
    result: isSanctioned(name) ? 'fail' : 'pass',
    checked_at: new Date().toISOString(),
    checks: [
      check('Identity from bank login (Plaid)', true, 'Account owner name returned by the bank'),
      check('Sanctions screen (OFAC SDN list)', !isSanctioned(name), isSanctioned(name) ? 'Potential match' : 'No match'),
    ],
  };
}

/**
 * Checks before each payment. `decision` is pass | warn | block. Only a sanctions hit or a failed identity check
 * blocks; balance, duplicate and velocity findings warn, so the R01 demo still works.
 */
export async function checkPayment(client, { account, direction, amount_cents }) {
  const checks = [
    check('Sanctions re-screen (OFAC)', !isSanctioned(account.holder_name), isSanctioned(account.holder_name) ? 'Potential match' : 'No match'),
    check('Account validated before WEB debit (Nacha rule)', account.status === 'verified',
      account.source === 'plaid' ? 'Instant verification (Plaid Auth)' : 'Micro-deposits confirmed'),
  ];
  const kyc = account.kyc?.result;
  checks.push(kyc === 'fail'
    ? check('Customer identity', false, 'Identity verification failed')
    : kyc === 'pass' ? check('Customer identity', true, 'Verified when the account was added')
      : warn('Customer identity', 'Not collected for this account'));

  if (direction === 'debit') {
    const available = balanceFor(account.last4);
    checks.push(available >= amount_cents
      ? check('Balance check', true, `Available $${(available / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`)
      : warn('Balance check', `Only $${(available / 100).toFixed(2)} available: likely R01 return`));
  }

  const { rows: [{ dupes, recent }] } = await client.query(
    `SELECT count(*) FILTER (WHERE amount_cents = $2 AND direction = $3 AND created_at > now() - interval '10 minutes')::int AS dupes,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS recent
       FROM transfers WHERE bank_account_id = $1 AND status NOT IN ('cancelled', 'failed')`,
    [account.id, amount_cents, direction],
  );
  checks.push(dupes ? warn('Duplicate check', `${dupes} identical payment(s) in the last 10 minutes`) : check('Duplicate check', true, 'No recent identical payment'));
  checks.push(recent >= 5 ? warn('Velocity check', `${recent} payments in 24 hours`) : check('Velocity check', true, `${recent} payment(s) in 24 hours`));

  const decision = checks.some((c) => c.level === 'fail') ? 'block' : checks.some((c) => c.level === 'warn') ? 'warn' : 'pass';
  return { decision, checked_at: new Date().toISOString(), checks };
}
