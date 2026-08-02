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
});

const parsed = schema.safeParse(process.env);

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
