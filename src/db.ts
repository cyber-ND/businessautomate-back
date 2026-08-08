import { PrismaClient } from '@prisma/client';

import { env, isProduction } from './env.js';

// A single client for the process. In watch mode tsx reloads modules on every
// save, and a fresh PrismaClient per reload exhausts the Postgres connection
// limit within a few minutes — so in development the instance is parked on
// globalThis and reused across reloads.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
    log: isProduction ? ['warn', 'error'] : ['warn', 'error'],
  });

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}

/**
 * Cheap connectivity probe for the readiness endpoint. Kept separate from
 * liveness: an unreachable database should fail readiness, not trigger a
 * container restart.
 */
export async function checkDbConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
