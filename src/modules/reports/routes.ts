import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { IntakeSchema } from '../intake/schema.js';
import {
  FreeAuditLimitError,
  ReportNotFoundError,
  ReportStateError,
  answerFollowUp,
  createReport,
  getReport,
  retryReport,
} from './service.js';

const ReportIdParams = z.object({ id: z.string().min(1).max(64) });

// Only the answer. The question comes from the report's stored pendingQuestion,
// so a client cannot pair an answer with a question of its own choosing and
// influence what reaches the prompt.
const AnswerBody = z.object({ answer: z.string().trim().min(1).max(2000) });

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Start an audit.
   *
   * Returns 202, not 201: the report exists but is not ready, and generation
   * takes 75-115 seconds. The client polls GET /api/reports/:id from here.
   */
  app.post(
    '/reports',
    {
      config: {
        // Every report creation costs real money in model tokens, so this is
        // far tighter than the global limit. Per-email free-tier caps are a
        // separate concern, handled in the abuse-caps milestone.
        rateLimit: { max: 5, timeWindow: '10 minutes' },
      },
    },
    async (request, reply) => {
      const parsed = IntakeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: 'INVALID_INTAKE',
            message: 'Some answers were missing or malformed.',
            fields: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        });
      }

      try {
        const report = await createReport(parsed.data);
        return reply.code(202).send(report);
      } catch (error) {
        if (error instanceof FreeAuditLimitError) {
          // 403, not 429: this is not "too fast", it is "that is all the free
          // audits this address gets". A 429 would invite the client to retry.
          return reply.code(403).send({
            error: {
              code: 'FREE_LIMIT_REACHED',
              message: `You have used your ${error.limit} free audits. Open your existing audit, or unlock the full report to go further.`,
              limit: error.limit,
              // Lets the client link straight to the audit they already have
              // rather than dead-ending. Most people hitting this simply forgot.
              existingReportId: error.latestReportId,
            },
          });
        }
        throw error;
      }
    },
  );

  /** Poll for status and, once complete, the audit shaped by payment state. */
  app.get('/reports/:id', async (request, reply) => {
    const params = ReportIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'INVALID_ID', message: 'Malformed report id.' } });
    }

    try {
      return await getReport(params.data.id);
    } catch (error) {
      if (error instanceof ReportNotFoundError) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such report.' } });
      }
      throw error;
    }
  });

  /** Answer the adaptive follow-up question and resume generation. */
  app.post('/reports/:id/answers', async (request, reply) => {
    const params = ReportIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'INVALID_ID', message: 'Malformed report id.' } });
    }

    const body = AnswerBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_ANSWER', message: 'An answer is required.' } });
    }

    try {
      return await answerFollowUp(params.data.id, body.data.answer);
    } catch (error) {
      if (error instanceof ReportNotFoundError) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such report.' } });
      }
      if (error instanceof ReportStateError) {
        // 409, not 400: the request is well-formed, the report is just not in a
        // state that accepts it — usually a double submit.
        return reply.code(409).send({ error: { code: 'WRONG_STATE', message: error.message } });
      }
      throw error;
    }
  });

  /** Retry a failed generation. */
  app.post(
    '/reports/:id/retry',
    { config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const params = ReportIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: { code: 'INVALID_ID', message: 'Malformed report id.' } });
      }

      try {
        return await retryReport(params.data.id);
      } catch (error) {
        if (error instanceof ReportNotFoundError) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such report.' } });
        }
        if (error instanceof ReportStateError) {
          return reply.code(409).send({ error: { code: 'WRONG_STATE', message: error.message } });
        }
        throw error;
      }
    },
  );
}
