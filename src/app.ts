import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import { env, isProduction, webOrigins } from './env.js';
import { registerHealthRoutes } from './routes/health.js';

/**
 * Builds the app without listening, so tests can drive it via `app.inject()`
 * and `server.ts` stays a thin entry point.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Pretty logs locally; structured JSON in production where Railway
      // collects them.
      transport: isProduction ? undefined : { target: 'pino-pretty' },
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-paystack-signature"]'],
    },
    // Railway terminates TLS in front of us, so trust its forwarding headers —
    // otherwise every client looks like it shares one internal IP and per-IP
    // rate limiting becomes a global limit.
    trustProxy: true,
    // The intake carries a free-text pain-points field; 256KB is generous for
    // that and still far below anything worth worrying about.
    bodyLimit: 256 * 1024,
  });

  await app.register(helmet, {
    // This is a JSON API consumed by a separate frontend origin, so the
    // browser-document protections don't apply.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
  });

  await app.register(cors, {
    origin: webOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: false,
    maxAge: 86_400,
  });

  // A baseline ceiling so no single IP can flood the API. Expensive routes
  // (report creation) get their own tighter limits at the route level.
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
  });

  await app.register(registerHealthRoutes);

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` },
    });
  });

  // One error shape for the whole API. Internal messages are logged, never
  // returned — intake data is sensitive business information and a stack trace
  // is not something a visitor should ever see.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;

    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled request error');
      reply.code(status).send({
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our end.' },
      });
      return;
    }

    request.log.warn({ err: error }, 'request rejected');
    reply.code(status).send({
      error: { code: error.code ?? 'BAD_REQUEST', message: error.message },
    });
  });

  return app;
}
