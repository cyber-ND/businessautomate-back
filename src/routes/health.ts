import type { FastifyInstance } from 'fastify';

import { checkDbConnection } from '../db.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Liveness. Deliberately touches nothing — Railway should not restart a
   * healthy container just because Postgres is briefly unreachable.
   */
  app.get('/health', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  /**
   * Readiness. Confirms we can actually serve traffic, which means the database
   * answers. Returns 503 when it does not, so a deploy that cannot reach
   * Postgres is visibly broken rather than quietly failing per-request.
   */
  app.get('/ready', async (_request, reply) => {
    const database = await checkDbConnection();

    if (!database) {
      return reply.code(503).send({ status: 'unavailable', database: false });
    }

    return { status: 'ok', database: true };
  });
}
