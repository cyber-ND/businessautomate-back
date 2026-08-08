import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { AuditSchema } from '../ai-engine/audit-schema.js';
import { sendInBackground, sendReportUnlocked } from '../email/service.js';
import { priceCurrencyFor, priceMinorFor, type CurrencyCode } from '../intake/currency.js';
import { initializeTransaction, verifyTransaction } from './paystack.js';

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
  /** Currency the customer will actually be charged in. */
  currency: string;
  /**
   * Currency the audit's figures are in. Usually identical to `currency`. When it
   * differs, the client must show both rather than implying one — the customer is
   * reading savings in one currency and paying in another.
   */
  auditCurrency: string;
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

  // Charge in the audit's own currency where Paystack allows it, so the reader
  // compares price against savings without arithmetic. Falls back to a billable
  // currency otherwise, rather than sending Paystack a currency it will reject
  // with a 403 at the checkout button.
  const audit = AuditSchema.safeParse(report.result);
  if (!audit.success) {
    throw new CheckoutStateError('This report has no readable audit to sell.');
  }

  const auditCurrency: CurrencyCode = audit.data.currency;
  const currency = priceCurrencyFor(auditCurrency);
  const amountMinor = priceMinorFor(currency);

  if (currency !== auditCurrency) {
    // Not an error, but worth seeing in logs: it means a visitor is being priced
    // in a currency their audit is not written in, which is the signal to enable
    // that currency on the Paystack account.
    logger.info(
      { reportId, auditCurrency, priceCurrency: currency },
      'pricing in a different currency than the audit',
    );
  }

  // A fresh reference every time, deliberately.
  //
  // An earlier version reused the most recent PENDING row to avoid leaving
  // several behind. That broke the moment a payment succeeded at Paystack while
  // our row stayed PENDING — which is exactly what happens when a webhook does
  // not arrive. The next click re-sent a reference Paystack had already
  // processed, and Paystack rejects duplicates, so the customer who had already
  // paid could not even reach the payment page again.
  //
  // Spare PENDING rows are harmless: each is independently verifiable, and only
  // the one Paystack confirms is ever marked SUCCESS.
  const reference = `ba_${reportId}_${randomUUID().slice(0, 8)}`;

  await prisma.payment.create({
    data: { reportId, reference, amountMinor, currency, status: 'PENDING' },
  });

  const session = await initializeTransaction({
    email: report.email,
    amountMinor,
    currency,
    reference,
    callbackUrl: `${env.WEB_APP_URL}/report/${reportId}`,
    metadata: { reportId },
  });

  return {
    authorizationUrl: session.authorizationUrl,
    reference,
    amountMinor,
    currency,
    auditCurrency,
  };
}

/**
 * Confirm a payment with Paystack directly and unlock if it went through.
 *
 * Called when the customer returns from checkout. The webhook is a push and can
 * simply fail to arrive — blocked, lost to a restart mid-delivery, or aimed at a
 * localhost address Paystack cannot reach — and a customer who has paid must not
 * be left looking at a paywall because of it.
 *
 * Safe to call repeatedly: it reuses the same idempotent unlock as the webhook,
 * so whichever arrives second is a no-op.
 */
export async function verifyAndUnlock(reference: string): Promise<WebhookOutcome> {
  const payment = await prisma.payment.findUnique({ where: { reference } });
  if (!payment) {
    logger.warn({ reference }, 'verify requested for an unknown reference');
    return { handled: false, reason: 'unknown reference' };
  }

  if (payment.status === 'SUCCESS') {
    return { handled: true, reportId: payment.reportId, alreadyProcessed: true };
  }

  const verified = await verifyTransaction(reference);

  if (verified.status !== 'success') {
    logger.info({ reference, status: verified.status }, 'verified transaction has not succeeded');
    return { handled: false, reason: `transaction is ${verified.status}` };
  }

  // Never unlock for less than the asking price. Paystack reports what was
  // actually captured, and trusting our own expectation instead would make the
  // amount decorative.
  if (verified.amountMinor < payment.amountMinor) {
    logger.error(
      { reference, expected: payment.amountMinor, received: verified.amountMinor },
      'verified amount is below the price; refusing to unlock',
    );
    return { handled: false, reason: 'amount mismatch' };
  }

  return applySuccessfulPayment(payment.reference, verified.raw);
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

  return applySuccessfulPayment(payment.reference, payload);
}

/**
 * Mark a payment successful and unlock its report.
 *
 * Shared by the webhook and by verify-on-return so the two can never drift: both
 * routes to "this payment went through" must produce exactly the same writes, or
 * a report unlocked by one would differ from one unlocked by the other.
 *
 * Idempotent. Paystack retries webhooks, and the customer's return can race the
 * delivery, so whichever arrives second must be a no-op.
 */
async function applySuccessfulPayment(
  reference: string,
  providerPayload: unknown,
): Promise<WebhookOutcome> {
  const payment = await prisma.payment.findUnique({
    where: { reference },
    include: { report: true },
  });

  if (!payment) return { handled: false, reason: 'unknown reference' };

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
        providerPayload: providerPayload as Prisma.InputJsonValue,
      },
    }),
    prisma.report.update({
      where: { id: payment.reportId },
      // Only set paidAt if it is not already set, so a replay cannot move the
      // timestamp the 30-day re-run window is measured from.
      data: { paidAt: payment.report.paidAt ?? new Date() },
    }),
  ]);

  logger.info(
    { reportId: payment.reportId, reference, amountMinor: payment.amountMinor },
    'report unlocked by payment',
  );

  // Not awaited: Paystack is waiting on the webhook response and will retry the
  // whole delivery if it is slow or errors. The unlock is already committed, so
  // a failed email must not cause a redelivery of an event we have handled.
  sendInBackground(() => sendReportUnlocked(payment.reportId), {
    reportId: payment.reportId,
    email: 'unlocked',
  });

  return { handled: true, reportId: payment.reportId, alreadyProcessed: false };
}
