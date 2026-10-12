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
    country_codes: [CountryCode.Us],
    language: 'en',
  });
  return res.data.link_token;
}

/** Exchanges a Link public_token and returns the item plus ACH numbers for each account. */
export async function exchangeAndGetAuth(publicToken) {
  const { data: exchange } = await plaid.itemPublicTokenExchange({ public_token: publicToken });
  const { data: auth } = await plaid.authGet({ access_token: exchange.access_token });

  const accounts = auth.numbers.ach
    .map((n) => {
      const acct = auth.accounts.find((a) => a.account_id === n.account_id);
      return {
        plaidAccountId: n.account_id,
        name: acct?.name,
        type: acct?.subtype === 'savings' ? 'savings' : 'checking',
        subtype: acct?.subtype,
        routing: n.routing,
        account: n.account,
      };
    })
    .filter((a) => a.subtype === 'checking' || a.subtype === 'savings');

  return { itemId: exchange.item_id, accessToken: exchange.access_token, accounts };
}
