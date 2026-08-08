import { env } from '../../env.js';

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

/** The currency this customer actually lives in, ignoring what we can bill. */
export function localCurrencyForCountry(country: string | undefined): CurrencyCode {
  if (!country) return 'USD';

  const normalised = country.trim().toLowerCase();
  for (const entry of COUNTRY_TO_CURRENCY) {
    if (entry.match.includes(normalised)) return entry.currency;
  }
  return 'USD';
}

// ---------------------------------------------------------------------------
// Billable currencies
// ---------------------------------------------------------------------------

/**
 * Currencies Paystack will actually accept for this account, in preference
 * order.
 *
 * A Nigeria-registered business has NGN by default and can add USD after
 * compliance plus a Zenith Bank USD domiciliary account; GHS, KES and ZAR belong
 * to businesses registered in those countries. Charging an unenabled currency
 * returns 403 "Currency not supported by merchant".
 */
export function billableCurrencies(): CurrencyCode[] {
  const configured = env.PAYSTACK_CURRENCIES.split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code): code is CurrencyCode =>
      (SUPPORTED_CURRENCIES as readonly string[]).includes(code),
    );

  // env validation rejects an empty list, so this only guards against a
  // programmer bypassing it.
  return configured.length > 0 ? configured : ['NGN'];
}

export function isBillable(currency: CurrencyCode): boolean {
  return billableCurrencies().includes(currency);
}

/**
 * Which currency an audit is written in: always the customer's own.
 *
 * Deliberately NOT restricted to what we can charge. An earlier version tied the
 * two together so the price would always match, but that produced naira audits
 * for American visitors — and "₦983,000 a month is leaking" is meaningless to
 * someone who thinks in dollars. A reader who cannot understand the savings will
 * never reach the price at all, so the audit's readability wins.
 */
export function auditCurrencyForCountry(country: string | undefined): CurrencyCode {
  return localCurrencyForCountry(country);
}

/**
 * Which currency to charge a given audit in.
 *
 * Matches the audit when Paystack can accept it, which is the case we optimise
 * for: the reader compares price against savings in one currency and needs no
 * arithmetic. Otherwise USD, understood almost everywhere, and failing that
 * whatever is enabled.
 *
 * The mismatched case is real but narrow — a Ghanaian reading a GHS audit priced
 * in naira — and it resolves by enabling the currency on Paystack, not by
 * changing code. Callers should surface both currencies rather than pretend they
 * are the same.
 */
export function priceCurrencyFor(auditCurrency: CurrencyCode): CurrencyCode {
  if (isBillable(auditCurrency)) return auditCurrency;
  if (isBillable('USD')) return 'USD';
  return billableCurrencies()[0] ?? 'NGN';
}

const PRICE_ENV_KEYS: Record<CurrencyCode, keyof typeof env> = {
  NGN: 'REPORT_PRICE_NGN_MINOR',
  USD: 'REPORT_PRICE_USD_MINOR',
  GHS: 'REPORT_PRICE_GHS_MINOR',
  KES: 'REPORT_PRICE_KES_MINOR',
  ZAR: 'REPORT_PRICE_ZAR_MINOR',
};

/** The report price for a currency, in minor units. */
export function priceMinorFor(currency: CurrencyCode): number {
  return env[PRICE_ENV_KEYS[currency]] as number;
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
