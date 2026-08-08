import { pino } from 'pino';

import { env, isProduction } from './env.js';

// Note: PAYSTACK_SECRET_KEY and RESEND_API_KEY are still hard requirements in
// production (see env.ts). What is relaxed here is only their *quality*.

// One logger for the whole process, shared by Fastify and by background work.
// Report generation runs outside any request, so it has no request logger to
// borrow — without this, the most important thing the system does would log
// through a different channel than everything else.
const baseLogger = pino({
  level: env.LOG_LEVEL,
  transport: isProduction ? undefined : { target: 'pino-pretty' },
  redact: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-paystack-signature"]',
  ],
});

export const logger = baseLogger;

// Configuration that is legal but degraded. These would each be a hard boot
// failure if the cost of being down exceeded the cost of running degraded — for
// these it does not, so they are shouted about instead of enforced.
if (isProduction) {
  if (env.EMAIL_FROM.includes('resend.dev')) {
    logger.warn(
      { emailFrom: env.EMAIL_FROM },
      'EMAIL_FROM uses Resend\'s shared test sender: email will ONLY reach the Resend account owner. ' +
        'Verify a domain at resend.com/domains and set EMAIL_FROM to an address on it.',
    );
  }

  if (!env.PAYSTACK_SECRET_KEY?.startsWith('sk_live_')) {
    logger.warn('PAYSTACK_SECRET_KEY is not a live key: no real payment can be taken.');
  }
}
