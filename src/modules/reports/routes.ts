import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { IntakeSchema } from '../intake/schema.js';
import {
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

      const report = await createReport(parsed.data);
      return reply.code(202).send(report);
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
