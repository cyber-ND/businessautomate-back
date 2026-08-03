import { env } from '../../env.js';

// Two currencies live in this codebase and they must never be confused.
//
// The AUDIT is denominated in USD — the model reasons in dollars, and every
// savings figure it produces is `...Usd`. The PRICE is whatever Paystack is
// configured to charge, currently NGN.
//
// So an email that says "your audit found X/month, unlock for Y" is quoting two
// different currencies in one sentence. These helpers keep that explicit rather
// than letting a bare number pick up whichever symbol is nearby.

/** Format a savings figure from the audit. Always USD. */
export function formatAuditUsd(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

/** Format the report price from config, converting minor units to major. */
export function formatPrice(): string {
  const major = env.REPORT_PRICE_MINOR / 100;
  const formatted = major.toLocaleString('en-US', {
    minimumFractionDigits: major % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return env.REPORT_CURRENCY === 'NGN' ? `₦${formatted}` : `$${formatted}`;
}
