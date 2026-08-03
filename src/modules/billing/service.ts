import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { sendInBackground, sendReportUnlocked } from '../email/service.js';
import { initializeTransaction } from './paystack.js';

export class CheckoutStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckoutStateError';
  }
}

export class ReportNotFoundError extends Error {
  constructor(reportId: string) {
    super(`Report ${reportId} not found`);
    this.name = 'ReportNotFoundError';
  }
}

export interface CheckoutSession {
  authorizationUrl: string;
  reference: string;
  amountMinor: number;
  currency: string;
}

/**
 * Start a payment for one report.
 *
 * The whole entitlement model is here: a payment is attached to a report id, so
 * auditing a second business requires a second payment by construction. There
 * is no account-level entitlement to abuse.
 */
export async function createCheckout(reportId: string): Promise<CheckoutSession> {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) throw new ReportNotFoundError(reportId);

  if (report.paidAt) {
    throw new CheckoutStateError('This report has already been paid for.');
  }

  // Refusing to sell an unfinished report. Taking money for something that
  // might still fail generation is the kind of thing a customer never forgives.
  if (report.status !== 'COMPLETED') {
    throw new CheckoutStateError(`Report is ${report.status}; it is not ready to purchase yet.`);
  }

  // Reuse an unpaid attempt rather than minting a new reference on every click.
  // Otherwise a customer who bounces off the payment page twice leaves three
  // pending rows and three references that could each still complete.
  //
  // Reuse only when the price still matches. If pricing or currency changed
  // since the row was written, the stored amount would no longer describe what
  // we are about to ask Paystack to charge, and reconciling the webhook against
  // it would compare two different numbers.
  const existing = await prisma.payment.findFirst({
    where: {
      reportId,
      status: 'PENDING',
      amountMinor: env.REPORT_PRICE_MINOR,
      currency: env.REPORT_CURRENCY,
    },
    orderBy: { createdAt: 'desc' },
  });

  const reference = existing?.reference ?? `ba_${reportId}_${randomUUID().slice(0, 8)}`;

  if (!existing) {
    await prisma.payment.create({
      data: {
        reportId,
        reference,
        amountMinor: env.REPORT_PRICE_MINOR,
        currency: env.REPORT_CURRENCY,
        status: 'PENDING',
      },
    });
  }

  const session = await initializeTransaction({
    email: report.email,
    amountMinor: env.REPORT_PRICE_MINOR,
    currency: env.REPORT_CURRENCY,
    reference,
    callbackUrl: `${env.WEB_APP_URL}/report/${reportId}`,
    metadata: { reportId },
  });

  return {
    authorizationUrl: session.authorizationUrl,
    reference,
    amountMinor: env.REPORT_PRICE_MINOR,
    currency: env.REPORT_CURRENCY,
  };
}

const WebhookEventSchema = z.object({
  event: z.string(),
  data: z.object({
    reference: z.string(),
    status: z.string().optional(),
    amount: z.number().optional(),
    currency: z.string().optional(),
  }),
});

export type WebhookOutcome =
  | { handled: true; reportId: string; alreadyProcessed: boolean }
  | { handled: false; reason: string };

/**
 * Apply a verified Paystack webhook.
 *
 * Caller MUST have verified the signature first — this trusts its input.
 *
 * Idempotent: Paystack retries deliveries, and a duplicate must not unlock
 * twice or overwrite the original paidAt. The unique constraint on
 * Payment.reference plus the status check below is what makes that safe.
 */
export async function handleWebhookEvent(payload: unknown): Promise<WebhookOutcome> {
  const parsed = WebhookEventSchema.safeParse(payload);
  if (!parsed.success) {
    return { handled: false, reason: 'unrecognised payload shape' };
  }

  const { event, data } = parsed.data;

  // Everything else Paystack sends (transfers, subscriptions, refunds) is not
  // something this product does yet. Acknowledge and ignore rather than error,
  // so Paystack does not retry an event we will never handle.
  if (event !== 'charge.success') {
    return { handled: false, reason: `ignoring event ${event}` };
  }

  const payment = await prisma.payment.findUnique({
    where: { reference: data.reference },
    include: { report: true },
  });

  if (!payment) {
    // A charge we have no record of. Worth alerting on: it means either a
    // reference collision, a stale test webhook, or someone paying through a
    // link we did not create.
    logger.warn({ reference: data.reference }, 'webhook for an unknown payment reference');
    return { handled: false, reason: 'unknown reference' };
  }

  if (payment.status === 'SUCCESS') {
    return { handled: true, reportId: payment.reportId, alreadyProcessed: true };
  }

  // Both writes in one transaction: a payment marked SUCCESS whose report is
  // still locked would be a customer who paid and got nothing.
  await prisma.$transaction([
    prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'SUCCESS',
        paidAt: new Date(),
        providerPayload: payload as Prisma.InputJsonValue,
      },
    }),
    prisma.report.update({
      where: { id: payment.reportId },
      // Only set paidAt if it is not already set, so a replayed webhook cannot
      // move the timestamp that the 30-day re-run window is measured from.
      data: { paidAt: payment.report.paidAt ?? new Date() },
    }),
  ]);

  logger.info(
    { reportId: payment.reportId, reference: data.reference, amountMinor: payment.amountMinor },
    'report unlocked by payment',
  );

  // Not awaited: Paystack is waiting on this response and will retry the whole
  // webhook if it is slow or errors. The unlock is already committed, so a
  // failed email must not cause a redelivery of an event we have handled.
  sendInBackground(() => sendReportUnlocked(payment.reportId), {
    reportId: payment.reportId,
    email: 'unlocked',
  });

  return { handled: true, reportId: payment.reportId, alreadyProcessed: false };
}
