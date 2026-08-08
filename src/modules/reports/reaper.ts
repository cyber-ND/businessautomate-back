import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { failReport, maxAttempts, resumeReport } from './service.js';

// Report generation runs in the web process rather than a queue — a considered
// trade, documented in the README. The cost of that trade is exactly this file.
//
// When the process restarts mid-generation (a Railway redeploy, a crash, an OOM),
// any report in flight is abandoned: the row still says PROCESSING and nothing is
// working on it. Without a reaper the visitor watches an analysing screen forever,
// which is the worst possible failure — they waited, and we lost their audit.
//
// Two stalled shapes, both recoverable:
//
//   PENDING with no startedAt   the process died between creating the row and
//                               starting work, so nothing ever ran
//   PROCESSING past the cutoff  work started and the process died during it

export interface ReapResult {
  resumed: number;
  failed: number;
}

export async function reapStalledReports(): Promise<ReapResult> {
  const cutoff = new Date(Date.now() - env.REPORT_STALE_AFTER_MINUTES * 60 * 1000);
  const result: ReapResult = { resumed: 0, failed: 0 };

  const stalled = await prisma.report.findMany({
    where: {
      OR: [
        // Started, then the process vanished.
        { status: 'PROCESSING', startedAt: { lte: cutoff } },
        // Never started. createdAt is the only clock we have here.
        { status: 'PENDING', startedAt: null, createdAt: { lte: cutoff } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    // Bounded so a large backlog cannot start hundreds of concurrent model calls
    // in one sweep. The next sweep picks up the rest.
    take: 20,
    select: { id: true, status: true, attempts: true, startedAt: true },
  });

  if (stalled.length === 0) return result;

  logger.warn({ count: stalled.length }, 'found stalled reports');

  for (const report of stalled) {
    if (report.attempts >= maxAttempts()) {
      // Out of attempts. Better a visible FAILED the customer can retry
      // deliberately than an infinite loop burning tokens on a bad intake.
      logger.error(
        { reportId: report.id, attempts: report.attempts },
        'stalled report is out of attempts; marking failed',
      );
      await failReport(report.id, 'STALLED');
      result.failed += 1;
      continue;
    }

    logger.info(
      { reportId: report.id, status: report.status, attempts: report.attempts },
      'resuming stalled report',
    );
    resumeReport(report.id);
    result.resumed += 1;
  }

  return result;
}

/**
 * Sweep on an interval, and once immediately.
 *
 * The immediate run is the point: a restart is the main way reports get
 * abandoned, so the most valuable sweep is the one right after boot.
 */
export function startReaper(): () => void {
  const intervalMs = env.REAPER_INTERVAL_MINUTES * 60 * 1000;

  const sweep = (): void => {
    void reapStalledReports().catch((error: unknown) => {
      logger.error({ err: error }, 'reaper sweep failed');
    });
  };

  sweep();

  const timer = setInterval(sweep, intervalMs);
  // Do not hold the event loop open on shutdown.
  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
