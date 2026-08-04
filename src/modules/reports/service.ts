import { Prisma, type Report } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { AuditSchema, type Audit } from '../ai-engine/audit-schema.js';
import { getAiProvider } from '../ai-engine/index.js';
import { AuditGenerationError } from '../ai-engine/provider.js';
import { sendInBackground, sendReportReady } from '../email/service.js';
import { FollowUpSchema, IntakeSchema, MAX_FOLLOW_UPS, type Intake } from '../intake/schema.js';
import { gateAudit, type GatedAudit } from './gating.js';

// The conversation column holds the adaptive follow-up state. `pendingQuestion`
// is the one currently on screen and unanswered; `followUps` are the answered
// pairs that get fed into the audit prompt.
const ConversationSchema = z.object({
  followUps: z.array(FollowUpSchema).default([]),
  pendingQuestion: z.string().nullable().default(null),
});

type Conversation = z.infer<typeof ConversationSchema>;

const EMPTY_CONVERSATION: Conversation = { followUps: [], pendingQuestion: null };

function readConversation(value: Prisma.JsonValue | null): Conversation {
  if (!value) return EMPTY_CONVERSATION;
  const parsed = ConversationSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_CONVERSATION;
}

function readAudit(value: Prisma.JsonValue | null): Audit | null {
  if (!value) return null;
  const parsed = AuditSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export class ReportNotFoundError extends Error {
  constructor(readonly reportId: string) {
    super(`Report ${reportId} not found`);
    this.name = 'ReportNotFoundError';
  }
}

export class ReportStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportStateError';
  }
}

/**
 * This email has used up its free audits.
 *
 * Carries the most recent report so the client can send them back to the audit
 * they already have rather than dead-ending. Someone hitting this limit is
 * usually not an abuser — they are a returning visitor who forgot they had one.
 */
export class FreeAuditLimitError extends Error {
  constructor(
    readonly limit: number,
    readonly latestReportId: string | null,
  ) {
    super(`This email has already used its ${limit} free audits.`);
    this.name = 'FreeAuditLimitError';
  }
}

/**
 * Free audits already consumed by an email address.
 *
 * Counts reports that are unpaid and not failed. FAILED is excluded because a
 * generation that broke on our side must not burn the visitor's quota. Re-runs
 * are excluded because they inherit a parent's payment and are part of what that
 * payment bought.
 */
async function countFreeAuditsUsed(email: string): Promise<number> {
  return prisma.report.count({
    where: {
      email,
      paidAt: null,
      parentReportId: null,
      status: { in: ['PENDING', 'PROCESSING', 'AWAITING_ANSWERS', 'COMPLETED'] },
    },
  });
}

export interface ReportView {
  id: string;
  status: Report['status'];
  paid: boolean;
  createdAt: Date;
  completedAt: Date | null;
  /** Present only while status is AWAITING_ANSWERS. */
  question: string | null;
  /** How many follow-ups have been answered, so the client can show progress. */
  followUpsAnswered: number;
  followUpsRemaining: number;
  /** Present only once COMPLETED. Shaped by payment state. */
  audit: GatedAudit | null;
  failureCode: string | null;
}

function toView(report: Report): ReportView {
  const conversation = readConversation(report.conversation);
  const audit = readAudit(report.result);
  const paid = report.paidAt !== null;

  return {
    id: report.id,
    status: report.status,
    paid,
    createdAt: report.createdAt,
    completedAt: report.completedAt,
    question: report.status === 'AWAITING_ANSWERS' ? conversation.pendingQuestion : null,
    followUpsAnswered: conversation.followUps.length,
    followUpsRemaining: Math.max(0, MAX_FOLLOW_UPS - conversation.followUps.length),
    audit: audit ? gateAudit(audit, paid) : null,
    failureCode: report.failureCode,
  };
}

/**
 * Create a report and start work on it.
 *
 * Returns as soon as the row exists. Triage alone takes 4-5 seconds and
 * generation 75-115, so none of it happens inside the request — the client gets
 * an id immediately and polls.
 */
export async function createReport(input: unknown): Promise<ReportView> {
  const intake = IntakeSchema.parse(input);

  // Checked before the row is created, so a blocked attempt costs nothing. The
  // per-IP rate limit on this route is a separate concern: it stops a flood,
  // while this stops one person quietly running twenty free audits.
  const used = await countFreeAuditsUsed(intake.email);
  if (used >= env.FREE_AUDIT_LIMIT_PER_EMAIL) {
    const latest = await prisma.report.findFirst({
      where: { email: intake.email, paidAt: null, parentReportId: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    throw new FreeAuditLimitError(env.FREE_AUDIT_LIMIT_PER_EMAIL, latest?.id ?? null);
  }

  const report = await prisma.report.create({
    data: {
      email: intake.email,
      businessName: intake.businessName ?? null,
      intake: intake as unknown as Prisma.InputJsonValue,
      conversation: EMPTY_CONVERSATION as unknown as Prisma.InputJsonValue,
      status: 'PENDING',
    },
  });

  startPipeline(report.id);

  return toView(report);
}

export async function getReport(reportId: string): Promise<ReportView> {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) throw new ReportNotFoundError(reportId);
  return toView(report);
}

/**
 * Answer the pending follow-up question and resume.
 *
 * The question is taken from the stored `pendingQuestion` rather than from the
 * request body — otherwise a client could pair an arbitrary question with an
 * answer and steer what reaches the prompt.
 */
export async function answerFollowUp(reportId: string, answer: string): Promise<ReportView> {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) throw new ReportNotFoundError(reportId);

  if (report.status !== 'AWAITING_ANSWERS') {
    throw new ReportStateError(`Report is ${report.status}; it is not waiting for an answer.`);
  }

  const conversation = readConversation(report.conversation);
  if (!conversation.pendingQuestion) {
    throw new ReportStateError('Report is awaiting answers but has no pending question.');
  }

  const next: Conversation = {
    followUps: [...conversation.followUps, { question: conversation.pendingQuestion, answer }],
    pendingQuestion: null,
  };

  const updated = await prisma.report.update({
    where: { id: reportId },
    data: {
      conversation: next as unknown as Prisma.InputJsonValue,
      status: 'PENDING',
    },
  });

  startPipeline(reportId);

  return toView(updated);
}

// ---------------------------------------------------------------------------
// Background pipeline
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget. Deliberately not awaited: the HTTP response must not wait on
 * a two-minute model call.
 *
 * This runs in the web process rather than a queue, which is a considered
 * trade — see the README. The cost is that a process restart abandons whatever
 * was mid-flight, which is why Report carries `startedAt` and `attempts` for a
 * reaper to find and retry them.
 */
function startPipeline(reportId: string): void {
  void runPipeline(reportId).catch((error: unknown) => {
    logger.error({ err: error, reportId }, 'report pipeline crashed');
  });
}

async function runPipeline(reportId: string): Promise<void> {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) {
    logger.warn({ reportId }, 'pipeline started for a report that no longer exists');
    return;
  }

  const intake = IntakeSchema.safeParse(report.intake);
  if (!intake.success) {
    logger.error({ reportId }, 'stored intake does not match the schema');
    await fail(reportId, 'INVALID_INTAKE');
    return;
  }

  const conversation = readConversation(report.conversation);

  // Ask for a follow-up only while we are under the cap. Past it we audit with
  // what we have: a wizard that keeps asking stops feeling like a consultant.
  if (conversation.followUps.length < MAX_FOLLOW_UPS) {
    const triage = await getAiProvider().triageIntake(intake.data, conversation.followUps);

    if (!triage.ready && triage.question) {
      await prisma.report.update({
        where: { id: reportId },
        data: {
          status: 'AWAITING_ANSWERS',
          conversation: {
            ...conversation,
            pendingQuestion: triage.question,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      logger.info({ reportId, reason: triage.reason }, 'asking a follow-up question');
      return;
    }
  }

  await generate(reportId, intake.data, conversation.followUps);
}

async function generate(
  reportId: string,
  intake: Intake,
  followUps: { question: string; answer: string }[],
): Promise<void> {
  await prisma.report.update({
    where: { id: reportId },
    data: { status: 'PROCESSING', startedAt: new Date(), attempts: { increment: 1 } },
  });

  const startedAt = Date.now();

  try {
    const result = await getAiProvider().generateAudit(intake, followUps, env.AI_GENERATION_TIER);

    await prisma.report.update({
      where: { id: reportId },
      data: {
        status: 'COMPLETED',
        result: result.audit as unknown as Prisma.InputJsonValue,
        model: result.model,
        completedAt: new Date(),
        failureCode: null,
      },
    });

    logger.info(
      {
        reportId,
        model: result.model,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
      'audit generated',
    );

    // The visitor has been staring at an analysing screen for over a minute and
    // may well have closed the tab, so the report has to be able to reach them
    // without them waiting. Deliberately not awaited: a Resend outage must not
    // turn a successfully generated audit into a failed one.
    sendInBackground(() => sendReportReady(reportId), { reportId, email: 'ready' });
  } catch (error) {
    const code = error instanceof AuditGenerationError ? error.code : 'UNKNOWN';
    logger.error({ err: error, reportId, code }, 'audit generation failed');
    await fail(reportId, code);
  }
}

async function fail(reportId: string, failureCode: string): Promise<void> {
  await prisma.report.update({
    where: { id: reportId },
    data: { status: 'FAILED', failureCode },
  });
}

/**
 * Restart work on a report the pipeline abandoned.
 *
 * Used by the reaper. Unlike `retryReport` there is no state guard: the reaper
 * has already decided this report is stalled, and the point is to recover it.
 */
export function resumeReport(reportId: string): void {
  startPipeline(reportId);
}

/** Attempts already made, so the reaper can stop retrying a poison report. */
export function maxAttempts(): number {
  return env.REPORT_MAX_ATTEMPTS;
}

/** Mark a report failed. Exposed for the reaper. */
export async function failReport(reportId: string, failureCode: string): Promise<void> {
  await fail(reportId, failureCode);
}

/** Retry a failed report. Exposed so the client can offer a retry button. */
export async function retryReport(reportId: string): Promise<ReportView> {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) throw new ReportNotFoundError(reportId);

  if (report.status !== 'FAILED') {
    throw new ReportStateError(`Report is ${report.status}; only FAILED reports can be retried.`);
  }

  const updated = await prisma.report.update({
    where: { id: reportId },
    data: { status: 'PENDING', failureCode: null },
  });

  startPipeline(reportId);

  return toView(updated);
}
