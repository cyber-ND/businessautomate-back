import { z } from 'zod';

// Config is validated once, at boot. A missing or malformed variable should
// crash the process on startup with a readable message — never surface as a 500
// twenty seconds into a visitor's audit.
//
// Variables are added to this schema in the milestone that first uses them, so
// every commit stays independently bootable.

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Railway injects PORT; the default is for local work only.
  PORT: z.coerce.number().int().positive().default(3000),

  // Railway sets this in production. Binding to 127.0.0.1 there would make the
  // container unreachable from the platform's router.
  HOST: z.string().default('0.0.0.0'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Comma-separated browser origins allowed to call this API.
  WEB_ORIGIN: z.string().default('http://localhost:5173'),

  // Railway provides this for its managed Postgres instance.
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),

  // Model per tier. Free audits are marketing and run on Sonnet; paid audits
  // run on the best model available. Overridable so a model upgrade is a config
  // change and not a deploy.
  AI_MODEL_FREE: z.string().default('claude-sonnet-5'),
  AI_MODEL_PAID: z.string().default('claude-opus-5'),
  AI_MODEL_TRIAGE: z.string().default('claude-sonnet-5'),

  // Effort is the strongest lever on cost, latency and depth — stronger than
  // the model choice. Measured on the salon fixture, Sonnet at `high` was both
  // SLOWER and thinner than Opus at `high`, because it burned the budget
  // thinking rather than writing. Free therefore defaults lower.
  // Exposed as config so these can be retuned against real audits without a
  // code change.
  AI_EFFORT_FREE: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  AI_EFFORT_PAID: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),

  // Which tier's model writes the audit. The audit is generated ONCE and gating
  // is display-only, so this single choice decides what both free and paying
  // viewers are reading.
  //
  // Defaults to PAID: at low volume the difference is a few dollars a month, and
  // a stronger free teaser converts better. Regenerating on payment was
  // rejected — the customer would wait another 90 seconds having just paid.
  //
  // Flip to FREE when volume makes the ~2.5x cost difference matter
  // ($0.199 vs $0.079 per audit).
  AI_GENERATION_TIER: z.enum(['FREE', 'PAID']).default('PAID'),

  // Where the frontend lives. Paystack redirects the customer back here after
  // payment, and emailed report links point at it.
  WEB_APP_URL: z.string().url().default('http://localhost:5173'),

  // --- Payments (Paystack) ---
  // Optional so the app still boots for local work without payment keys;
  // required in production, enforced below. Silently running production with
  // payments disabled would be worse than failing to start.
  PAYSTACK_SECRET_KEY: z.string().optional(),

  // Currencies actually enabled on the Paystack account, most preferred first.
  //
  // A Nigeria-registered business gets NGN by default and can add USD after
  // passing compliance and attaching a Zenith Bank USD domiciliary account.
  // GHS/KES/ZAR belong to businesses registered in those countries.
  //
  // This list is load-bearing, not documentation: an audit is only ever
  // denominated in a currency listed here, so we can never produce a report we
  // are unable to charge for. Initializing a transaction in a currency Paystack
  // has not enabled returns 403 "Currency not supported by merchant".
  PAYSTACK_CURRENCIES: z.string().default('NGN'),

  // Prices in MINOR units — kobo for NGN, cents for USD — so money never
  // touches a float. One per currency we can bill.
  REPORT_PRICE_NGN_MINOR: z.coerce.number().int().positive().default(2_500_000),
  REPORT_PRICE_USD_MINOR: z.coerce.number().int().positive().default(4_900),
  REPORT_PRICE_GHS_MINOR: z.coerce.number().int().positive().default(60_000),
  REPORT_PRICE_KES_MINOR: z.coerce.number().int().positive().default(650_000),
  REPORT_PRICE_ZAR_MINOR: z.coerce.number().int().positive().default(90_000),

  // --- Email (Resend) ---
  RESEND_API_KEY: z.string().optional(),

  // Must be on a domain verified in Resend. `onboarding@resend.dev` is Resend's
  // shared test sender and works without verification, but it will only deliver
  // to the address that owns the Resend account — fine for development, useless
  // for real customers.
  EMAIL_FROM: z.string().min(1).default('BusinessAutomate <onboarding@resend.dev>'),

  // Hours to wait after a report completes before nudging a non-payer.
  FOLLOW_UP_DELAY_HOURS: z.coerce.number().int().nonnegative().default(24),
  // How many nudges one report may ever generate. Past this we stop: a third
  // reminder is not persuasion, it is spam, and it costs the sending domain's
  // reputation.
  FOLLOW_UP_MAX: z.coerce.number().int().nonnegative().default(2),
})
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === 'production' && !value.PAYSTACK_SECRET_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYSTACK_SECRET_KEY'],
        message: 'required in production — the app must not serve a paywall it cannot charge for',
      });
    }

    if (value.NODE_ENV === 'production' && !value.RESEND_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message:
          'required in production — a report nobody can be told about is a report nobody reads',
      });
    }

    if (value.NODE_ENV === 'production' && value.EMAIL_FROM.includes('resend.dev')) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_FROM'],
        message:
          "must use a verified domain in production — Resend's shared test sender only delivers to the account owner",
      });
    }

    const currencies = value.PAYSTACK_CURRENCIES.split(',')
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean);

    if (currencies.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYSTACK_CURRENCIES'],
        message: 'at least one currency is required — with none, no report can be priced',
      });
    }

    const known = ['NGN', 'USD', 'GHS', 'KES', 'ZAR'];
    for (const code of currencies) {
      if (!known.includes(code)) {
        ctx.addIssue({
          code: 'custom',
          path: ['PAYSTACK_CURRENCIES'],
          message: `${code} is not a currency Paystack supports (expected one of ${known.join(', ')})`,
        });
      }
    }
  });

// An empty variable means "not set", not "set to empty".
//
// `.env` files and deploy dashboards both make it easy to leave a name behind
// with no value. Zod treats `''` as a present value, so an empty EMAIL_FROM=
// would override its default and an empty PAYSTACK_SECRET_KEY= would read as
// configured, then fail at the first charge. Stripping blanks up front makes
// defaults and `.optional()` behave the way the schema reads.
const presentVariables = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined && value.trim() !== ''),
);

const parsed = schema.safeParse(presentVariables);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';

export const webOrigins = env.WEB_ORIGIN.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
