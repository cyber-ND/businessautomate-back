// The audit is denominated in the customer's own currency.
//
// A Lagos salon owner reading "$700/month is leaking" has to convert before she
// can feel it, and the conversion is exactly the moment the number stops being
// credible. "₦980,000 a month" lands. Since every savings figure is an estimate
// anyway, the right place to fix this is at generation — asking the model to
// reason in naira — rather than converting afterwards, which would compound
// estimate error with exchange-rate error and go stale.

export const SUPPORTED_CURRENCIES = ['NGN', 'GHS', 'KES', 'ZAR', 'USD'] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

// Matched loosely against whatever free text the visitor typed for country, so
// "nigeria", "Nigeria ", and "NG" all resolve. Anything unrecognised falls back
// to USD rather than guessing.
const COUNTRY_TO_CURRENCY: { match: string[]; currency: CurrencyCode }[] = [
  { match: ['nigeria', 'nigerian', 'ng', 'nga'], currency: 'NGN' },
  { match: ['ghana', 'ghanaian', 'gh'], currency: 'GHS' },
  { match: ['kenya', 'kenyan', 'ke'], currency: 'KES' },
  { match: ['south africa', 'south african', 'za', 'rsa'], currency: 'ZAR' },
];

export function currencyForCountry(country: string | undefined): CurrencyCode {
  if (!country) return 'USD';

  const normalised = country.trim().toLowerCase();
  for (const entry of COUNTRY_TO_CURRENCY) {
    if (entry.match.includes(normalised)) return entry.currency;
  }
  return 'USD';
}

interface CurrencyProfile {
  /** Symbol the model should use, and what we render. */
  symbol: string;
  /** Human name, so the prompt can be unambiguous about which currency. */
  name: string;
  /**
   * Rough guidance on realistic magnitudes. Without this a model asked for naira
   * has been known to produce dollar-sized numbers with a naira symbol, which is
   * a silent ~1,400x error and the most dangerous failure this file exists to
   * prevent.
   */
  scaleHint: string;
}

const PROFILES: Record<CurrencyCode, CurrencyProfile> = {
  NGN: {
    symbol: '₦',
    name: 'Nigerian naira',
    scaleHint:
      'Naira amounts are large: a small salon might lose ₦500,000-₦1,500,000 a month, and a tool costs ₦5,000-₦50,000 a month. Never quote a naira figure that would only make sense as dollars.',
  },
  GHS: {
    symbol: 'GH₵',
    name: 'Ghanaian cedi',
    scaleHint:
      'Cedi amounts are roughly 12-15x a dollar figure. A tool might cost GH₵100-GH₵600 a month.',
  },
  KES: {
    symbol: 'KSh',
    name: 'Kenyan shilling',
    scaleHint:
      'Shilling amounts are roughly 130x a dollar figure. A tool might cost KSh 1,500-KSh 8,000 a month.',
  },
  ZAR: {
    symbol: 'R',
    name: 'South African rand',
    scaleHint: 'Rand amounts are roughly 18x a dollar figure. A tool might cost R200-R1,200 a month.',
  },
  USD: {
    symbol: '$',
    name: 'US dollars',
    scaleHint: 'A tool for a small business typically costs $0-$150 a month.',
  },
};

export function currencyProfile(currency: CurrencyCode): CurrencyProfile {
  return PROFILES[currency];
}

const LOCALES: Record<CurrencyCode, string> = {
  NGN: 'en-NG',
  GHS: 'en-GH',
  KES: 'en-KE',
  ZAR: 'en-ZA',
  USD: 'en-US',
};

/**
 * Format a whole-currency amount for display.
 *
 * No decimals: these are estimates, and "₦983,214.57 a month" claims a
 * precision the underlying reasoning does not have.
 */
export function formatMoney(amount: number, currency: CurrencyCode): string {
  return new Intl.NumberFormat(LOCALES[currency], {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(Math.round(amount));
}

/**
 * Format a price held in minor units (kobo, cents).
 *
 * Kept separate from `formatMoney` because prices are stored as integers in
 * minor units to keep money off floats, while audit figures are whole units
 * produced by a model.
 */
export function formatMinorUnits(amountMinor: number, currency: string): string {
  const code = (SUPPORTED_CURRENCIES as readonly string[]).includes(currency)
    ? (currency as CurrencyCode)
    : 'USD';
  const major = amountMinor / 100;

  return new Intl.NumberFormat(LOCALES[code], {
    style: 'currency',
    currency: code,
    minimumFractionDigits: major % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(major);
}
