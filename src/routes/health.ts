import type { FastifyInstance } from 'fastify';

/**
 * Liveness endpoint. Deliberately does not touch the database — Railway should
 * not restart a healthy container just because Postgres is briefly unreachable.
 * Dependency checks belong in a separate readiness route, added when there are
 * dependencies to check.
 */
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
  }));
}
