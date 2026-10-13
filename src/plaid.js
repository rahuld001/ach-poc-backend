import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products } from 'plaid';

export const plaidEnabled = Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);

export const plaid = plaidEnabled
  ? new PlaidApi(
      new Configuration({
        basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
        baseOptions: {
          headers: {
            'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
            'PLAID-SECRET': process.env.PLAID_SECRET,
          },
        },
      }),
    )
  : null;

export async function createLinkToken(userId) {
  const res = await plaid.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'ACH POC',
    products: [Products.Auth],
    // Identity gives us the account owner's name as the bank holds it, for the NACHA Individual Name field and
    // sanctions screening. Optional so Link still works at institutions that do not support it.
    optional_products: [Products.Identity],
    country_codes: [CountryCode.Us],
    language: 'en',
  });
  return res.data.link_token;
}

/** Account owner names by account id from Plaid Identity, or an empty map when the item has no Identity data. */
async function ownerNames(accessToken) {
  try {
    const { data } = await plaid.identityGet({ access_token: accessToken });
    return new Map(data.accounts.map((a) => [a.account_id, a.owners?.[0]?.names?.[0]?.trim() || null]));
  } catch (err) {
    console.warn('[plaid] identity not available for this item:', err.response?.data?.error_code ?? err.message);
    return new Map();
  }
}

/** Exchanges a Link public_token and returns the item plus ACH numbers and owner name for each account. */
export async function exchangeAndGetAuth(publicToken) {
  const { data: exchange } = await plaid.itemPublicTokenExchange({ public_token: publicToken });
  const { data: auth } = await plaid.authGet({ access_token: exchange.access_token });
  const owners = await ownerNames(exchange.access_token);

  const accounts = auth.numbers.ach
    .map((n) => {
      const acct = auth.accounts.find((a) => a.account_id === n.account_id);
      return {
        plaidAccountId: n.account_id,
        name: acct?.name, // the account's label at the bank (e.g. "Plaid Checking"), not the owner
        ownerName: owners.get(n.account_id) ?? null, // from Plaid Identity, when available
        type: acct?.subtype === 'savings' ? 'savings' : 'checking',
        subtype: acct?.subtype,
        routing: n.routing,
        account: n.account,
      };
    })
    .filter((a) => a.subtype === 'checking' || a.subtype === 'savings');

  return { itemId: exchange.item_id, accessToken: exchange.access_token, accounts };
}
