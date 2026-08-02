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
