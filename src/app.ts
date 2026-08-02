import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError } from 'fastify';

import { webOrigins } from './env.js';
import { logger } from './logger.js';
import { registerReportRoutes } from './modules/reports/routes.js';
import { registerHealthRoutes } from './routes/health.js';

/**
 * Builds the app without listening, so tests can drive it via `app.inject()`
 * and `server.ts` stays a thin entry point.
 *
 * The return type is inferred rather than annotated as `FastifyInstance`:
 * passing a concrete pino instance as `loggerInstance` specialises Fastify's
 * logger generic, and the default `FastifyInstance` no longer matches it.
 */
export async function buildApp() {
  const app = Fastify({
    // Shared with background report generation, which runs outside any request
    // and would otherwise log through a separate channel.
    loggerInstance: logger,
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

  // Accept a bodyless POST without demanding a Content-Type. Fastify otherwise
  // answers 415, which is what a plain "retry" button sends — a confusing
  // media-type error for a request that carries no media at all. Anything with
  // an actual body and an unrecognised type still gets 415.
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
    if (typeof body === 'string' && body.length === 0) {
      done(null, {});
      return;
    }
    const error = new Error('Unsupported Media Type') as Error & { statusCode?: number };
    error.statusCode = 415;
    done(error, undefined);
  });

  await app.register(registerHealthRoutes);
  await app.register(registerReportRoutes, { prefix: '/api' });

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
