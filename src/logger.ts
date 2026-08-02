import { pino } from 'pino';

import { env, isProduction } from './env.js';

// One logger for the whole process, shared by Fastify and by background work.
// Report generation runs outside any request, so it has no request logger to
// borrow — without this, the most important thing the system does would log
// through a different channel than everything else.
export const logger = pino({
  level: env.LOG_LEVEL,
  transport: isProduction ? undefined : { target: 'pino-pretty' },
  redact: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-paystack-signature"]',
  ],
});
