// Print the environment block to paste into Railway's Raw Editor.
//
// Reads the local .env, drops development-only values, and substitutes what
// production needs — Railway's own DATABASE_URL reference, NODE_ENV, the real
// origins. Retyping a dozen variables by hand is how a deploy ends up with one
// silently wrong secret.
//
//   npm run railway:env            # secrets masked, safe to read aloud
//   npm run railway:env -- --real  # actual values, for pasting
//
// The Postgres service name defaults to "Postgres"; override if yours differs:
//   npm run railway:env -- --real --db-service=my-postgres

import '../load-env.js';

const args = process.argv.slice(2);
const real = args.includes('--real');
const dbService = args.find((a) => a.startsWith('--db-service='))?.split('=')[1] ?? 'Postgres';

// Values Railway must own rather than inherit from local development.
const overrides: Record<string, string> = {
  NODE_ENV: 'production',
  // Railway injects PORT; binding to it is required or the healthcheck fails.
  HOST: '0.0.0.0',
  // Reference to the Postgres service in the same project: private network,
  // no egress cost, no TCP proxy needed.
  DATABASE_URL: `\${{${dbService}.DATABASE_URL}}`,
  WEB_ORIGIN: 'https://brainycyber.com,https://www.brainycyber.com',
  WEB_APP_URL: 'https://brainycyber.com',
};

// Local-only. PORT is Railway's to set.
const skip = new Set(['PORT']);

const SECRET = /KEY|SECRET|TOKEN|PASSWORD/i;

function mask(value: string): string {
  if (value.length <= 8) return '********';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

// An explicit allowlist, not a prefix match. process.env carries the whole OS
// environment, and a pattern like /^AI_/ happily picked up an unrelated AI_AGENT
// variable from the developer's shell — exactly the kind of thing that ends up
// pasted into a production service.
const EXPORTABLE = [
  'LOG_LEVEL',
  'ANTHROPIC_API_KEY',
  'AI_MODEL_FREE',
  'AI_MODEL_PAID',
  'AI_MODEL_TRIAGE',
  'AI_EFFORT_FREE',
  'AI_EFFORT_PAID',
  'AI_GENERATION_TIER',
  'PAYSTACK_SECRET_KEY',
  'PAYSTACK_CURRENCIES',
  'REPORT_PRICE_NGN_MINOR',
  'REPORT_PRICE_USD_MINOR',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'FOLLOW_UP_DELAY_HOURS',
  'FOLLOW_UP_MAX',
  'FREE_AUDIT_LIMIT_PER_EMAIL',
  'REPORT_STALE_AFTER_MINUTES',
  'REPORT_MAX_ATTEMPTS',
  'REAPER_INTERVAL_MINUTES',
] as const;

const fromEnvFile: Record<string, string> = {};
for (const key of EXPORTABLE) {
  const value = process.env[key];
  if (skip.has(key) || value === undefined || value.trim() === '') continue;
  fromEnvFile[key] = value;
}

const merged = { ...fromEnvFile, ...overrides };

console.log('# Paste into Railway: your service > Variables > Raw Editor');
console.log(`# Postgres service assumed to be named "${dbService}"`);
if (!real) console.log('# SECRETS MASKED — rerun with --real to get pasteable values');
console.log('');

for (const key of Object.keys(merged).sort()) {
  const value = merged[key] ?? '';
  const shouldMask = !real && SECRET.test(key) && !value.startsWith('${{');
  console.log(`${key}=${shouldMask ? mask(value) : value}`);
}

console.log('');
console.log('# After the first deploy, check the logs for:');
console.log('#   "EMAIL_FROM uses Resend\'s shared test sender"  -> verify brainycyber.com in Resend');
console.log('#   "PAYSTACK_SECRET_KEY is not a live key"         -> expected until you go live');
