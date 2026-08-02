import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { logger } from '../../logger.js';
import { isPaystackConfigured, verifyWebhookSignature } from './paystack.js';
import {
  CheckoutStateError,
  ReportNotFoundError,
  createCheckout,
  handleWebhookEvent,
} from './service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Raw bytes, set only on the webhook scope. Needed for signature checks. */
    rawBody?: Buffer;
  }
}

const ReportIdParams = z.object({ reportId: z.string().min(1).max(64) });

export async function registerBillingRoutes(app: FastifyInstance): Promise<void> {
  /** Start a payment for one report and hand back the Paystack checkout URL. */
  app.post(
    '/checkout/:reportId',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      if (!isPaystackConfigured()) {
        return reply.code(503).send({
          error: {
            code: 'PAYMENTS_UNAVAILABLE',
            message: 'Payments are not configured on this environment.',
          },
        });
      }

      const params = ReportIdParams.safeParse(request.params);
      if (!params.success) {
        return reply
          .code(400)
          .send({ error: { code: 'INVALID_ID', message: 'Malformed report id.' } });
      }

      try {
        return await createCheckout(params.data.reportId);
      } catch (error) {
        if (error instanceof ReportNotFoundError) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such report.' } });
        }
        if (error instanceof CheckoutStateError) {
          return reply
            .code(409)
            .send({ error: { code: 'WRONG_STATE', message: error.message } });
        }
        throw error;
      }
    },
  );

  // The webhook lives in its own encapsulated scope so it can keep the raw
  // request bytes. Paystack signs the body exactly as sent; re-serialising the
  // parsed JSON reorders keys and whitespace, and the signature stops matching.
  // Scoping the parser this way keeps every other route on the normal fast JSON
  // path.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (request, body, done) => {
        const buffer = body as Buffer;
        request.rawBody = buffer;
        try {
          done(null, buffer.length ? JSON.parse(buffer.toString('utf8')) : {});
        } catch (error) {
          done(error as Error, undefined);
        }
      },
    );

    scope.post(
      '/webhooks/paystack',
      {
        config: {
          // Paystack retries aggressively on failure and legitimately bursts;
          // rate limiting the webhook would drop real payments.
          rateLimit: false,
        },
      },
      async (request, reply) => {
        if (!isPaystackConfigured()) {
          return reply.code(503).send({ error: { code: 'PAYMENTS_UNAVAILABLE' } });
        }

        const signature = request.headers['x-paystack-signature'];
        const raw = request.rawBody;

        if (!raw || typeof signature !== 'string' || !verifyWebhookSignature(raw, signature)) {
          // Deliberately terse. An attacker probing the endpoint learns nothing
          // about why their forgery failed.
          logger.warn({ ip: request.ip }, 'rejected webhook with a bad signature');
          return reply.code(401).send({ error: { code: 'INVALID_SIGNATURE' } });
        }

        const outcome = await handleWebhookEvent(request.body);

        // Always 200 once the signature is good, even for events we ignore.
        // A non-2xx tells Paystack to retry, and retrying an event we will
        // never handle just fills their queue and our logs.
        return reply.code(200).send({ received: true, ...outcome });
      },
    );
  });
}
