import { Resend } from 'resend';

import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { AuditSchema, type Audit } from '../ai-engine/audit-schema.js';
import { followUpEmail, reportReadyEmail, reportUnlockedEmail, type EmailContent } from './templates.js';

// Email is a side effect, never a dependency. Nothing in the funnel may fail
// because a message could not be delivered: the report still exists, the
// customer can still reach it, and the payment still unlocked it. Every function
// here logs and swallows.

let client: Resend | undefined;

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  client ??= new Resend(env.RESEND_API_KEY);
  return client;
}

export function isEmailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY);
}

async function send(to: string, content: EmailContent): Promise<boolean> {
  const resend = getClient();

  if (!resend) {
    // Development without a key. Log the subject so the flow is still
    // observable, rather than silently doing nothing.
    logger.info({ to, subject: content.subject }, 'email not sent (Resend not configured)');
    return false;
  }

  try {
    const result = await resend.emails.send({
      from: env.EMAIL_FROM,
      to,
      subject: content.subject,
      html: content.html,
      text: content.text,
    });

    if (result.error) {
      logger.error({ to, subject: content.subject, err: result.error }, 'Resend rejected the email');
      return false;
    }

    logger.info({ to, subject: content.subject, id: result.data?.id }, 'email sent');
    return true;
  } catch (error) {
    logger.error({ err: error, to, subject: content.subject }, 'email send threw');
    return false;
  }
}

function readAudit(value: unknown): Audit | null {
  const parsed = AuditSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Tell someone their audit is ready.
 *
 * Guarded by `readyEmailSentAt`, so a retried generation cannot email twice.
 */
export async function sendReportReady(reportId: string): Promise<void> {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report || report.status !== 'COMPLETED' || report.readyEmailSentAt) return;

  const audit = readAudit(report.result);
  if (!audit) {
    logger.warn({ reportId }, 'skipping ready email: stored audit is unreadable');
    return;
  }

  const sent = await send(
    report.email,
    reportReadyEmail({ reportId, businessName: report.businessName, audit }),
  );

  // Only stamp on success, so a transient Resend outage does not permanently
  // suppress the email — the sweep can pick it up later.
  if (sent) {
    await prisma.report.update({
      where: { id: reportId },
      data: { readyEmailSentAt: new Date() },
    });
  }
}

/** Confirm a payment and hand over the unlocked report. */
export async function sendReportUnlocked(reportId: string): Promise<void> {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report || !report.paidAt || report.unlockedEmailSentAt) return;

  const audit = readAudit(report.result);
  if (!audit) {
    logger.warn({ reportId }, 'skipping unlocked email: stored audit is unreadable');
    return;
  }

  const sent = await send(
    report.email,
    reportUnlockedEmail({ reportId, businessName: report.businessName, audit }),
  );

  if (sent) {
    await prisma.report.update({
      where: { id: reportId },
      data: { unlockedEmailSentAt: new Date() },
    });
  }
}

export interface FollowUpSweepResult {
  considered: number;
  sent: number;
  skipped: number;
}

/**
 * Nudge non-payers, quoting their own numbers.
 *
 * Run on a schedule. Selection is deliberately conservative: completed, unpaid,
 * under the nudge cap, and quiet for at least FOLLOW_UP_DELAY_HOURS since the
 * last contact. The delay is measured from the last thing we sent rather than
 * from completion, otherwise both nudges would fire in the same sweep the moment
 * a report aged past the threshold.
 */
export async function runFollowUpSweep(options: { dryRun?: boolean } = {}): Promise<FollowUpSweepResult> {
  const cutoff = new Date(Date.now() - env.FOLLOW_UP_DELAY_HOURS * 60 * 60 * 1000);

  const candidates = await prisma.report.findMany({
    where: {
      status: 'COMPLETED',
      paidAt: null,
      followUpsSent: { lt: env.FOLLOW_UP_MAX },
      OR: [
        { lastFollowUpAt: null, completedAt: { lte: cutoff } },
        { lastFollowUpAt: { lte: cutoff } },
      ],
    },
    orderBy: { completedAt: 'asc' },
    take: 200,
  });

  const result: FollowUpSweepResult = { considered: candidates.length, sent: 0, skipped: 0 };

  for (const report of candidates) {
    const audit = readAudit(report.result);
    if (!audit) {
      result.skipped += 1;
      continue;
    }

    const attempt = report.followUpsSent + 1;

    if (options.dryRun) {
      const content = followUpEmail({
        reportId: report.id,
        businessName: report.businessName,
        audit,
        attempt,
      });
      logger.info(
        { reportId: report.id, to: report.email, attempt, subject: content.subject },
        'follow-up (dry run)',
      );
      result.sent += 1;
      continue;
    }

    const sent = await send(
      report.email,
      followUpEmail({ reportId: report.id, businessName: report.businessName, audit, attempt }),
    );

    if (sent) {
      await prisma.report.update({
        where: { id: report.id },
        data: { followUpsSent: { increment: 1 }, lastFollowUpAt: new Date() },
      });
      result.sent += 1;
    } else {
      result.skipped += 1;
    }
  }

  return result;
}

/**
 * Fire an email without making the caller wait or handle failure.
 *
 * Used from the report pipeline and the payment webhook, where the work is
 * already done and the email must not delay or endanger the response.
 */
export function sendInBackground(task: () => Promise<void>, context: Record<string, unknown>): void {
  void task().catch((error: unknown) => {
    logger.error({ err: error, ...context }, 'background email failed');
  });
}
