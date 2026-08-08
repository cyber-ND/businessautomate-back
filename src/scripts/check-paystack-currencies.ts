// Ask Paystack which currencies this account can actually charge.
//
// Paystack has no endpoint that reports enabled currencies, so the only reliable
// answer is to attempt a transaction in each and read the rejection. Run this
// after enabling USD to confirm it took effect, rather than trusting the
// dashboard and discovering the truth at a customer's checkout button.
//
//   npm run paystack:currencies
//
// Safe to run: with a test key these are sandbox transactions nobody can pay,
// and initializing one charges nothing even on a live key. It refuses to run
// against a live key anyway — see below.

import '../load-env.js';

const { env } = await import('../env.js');
const { SUPPORTED_CURRENCIES, billableCurrencies, priceMinorFor } = await import(
  '../modules/intake/currency.js'
);

if (!env.PAYSTACK_SECRET_KEY) {
  console.error('PAYSTACK_SECRET_KEY is not set.');
  process.exit(1);
}

// Initializing a transaction is harmless, but creating stray records on a live
// account is untidy and this is a diagnostic. Keep it to test keys.
if (!env.PAYSTACK_SECRET_KEY.startsWith('sk_test_')) {
  console.error(
    'This probe only runs with a test key (sk_test_...). It would leave abandoned\n' +
      'transaction records on a live account.',
  );
  process.exit(1);
}

console.log(`configured PAYSTACK_CURRENCIES : ${billableCurrencies().join(', ')}`);
console.log('probing Paystack for what it will actually accept...\n');

const results: { currency: string; accepted: boolean; message: string }[] = [];

for (const currency of SUPPORTED_CURRENCIES) {
  const response = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'currency-probe@example.com',
      amount: priceMinorFor(currency),
      currency,
      // Distinct reference per run so a repeat probe is never rejected as a
      // duplicate, which would look like the currency was refused.
      reference: `probe_${currency}_${process.pid}_${Math.floor(process.uptime() * 1000)}`,
    }),
  });

  const body = (await response.json().catch(() => null)) as
    | { status?: boolean; message?: string }
    | null;

  const accepted = response.ok && body?.status === true;
  results.push({
    currency,
    accepted,
    message: accepted ? 'accepted' : (body?.message ?? `HTTP ${response.status}`),
  });
}

for (const result of results) {
  console.log(`${result.currency}  ${result.accepted ? 'YES' : 'no '}  ${result.message}`);
}

const accepted = results.filter((r) => r.accepted).map((r) => r.currency);
const configured = billableCurrencies();

console.log('');

if (accepted.length === 0) {
  console.log('Paystack accepted nothing. Check the key is valid and the account is activated.');
} else {
  console.log(`Paystack accepts    : ${accepted.join(', ')}`);
  console.log(`.env is configured  : ${configured.join(', ')}`);

  const missing = accepted.filter((c) => !configured.includes(c as (typeof configured)[number]));
  const overclaimed = configured.filter((c) => !accepted.includes(c));

  if (overclaimed.length > 0) {
    console.log(
      `\nPROBLEM: .env claims ${overclaimed.join(', ')} but Paystack rejects it.\n` +
        'Customers priced in that currency will fail at checkout. Remove it from\n' +
        'PAYSTACK_CURRENCIES until it is genuinely enabled.',
    );
  }

  if (missing.length > 0) {
    console.log(
      `\nAvailable but unused: ${missing.join(', ')}.\n` +
        `Add to PAYSTACK_CURRENCIES to start pricing customers in it:\n` +
        `  PAYSTACK_CURRENCIES=${[...configured, ...missing].join(',')}`,
    );
  }

  if (overclaimed.length === 0 && missing.length === 0) {
    console.log('\nConfiguration matches Paystack exactly.');
  }
}
