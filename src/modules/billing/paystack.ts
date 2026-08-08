import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '../../env.js';

// Thin Paystack client. Stripe is not fully available in Nigeria, which is why
// this exists instead of the Stripe integration named in TECH_MODEL.md.

const PAYSTACK_API = 'https://api.paystack.co';

export class PaystackNotConfiguredError extends Error {
  constructor() {
    super('Paystack is not configured (PAYSTACK_SECRET_KEY is unset).');
    this.name = 'PaystackNotConfiguredError';
  }
}

export class PaystackApiError extends Error {
  constructor(
    message: string,
    /**
     * Paystack's HTTP status. Deliberately NOT named `statusCode`: Fastify's
     * error handler reads that property and would relay Paystack's status
     * straight to our client, so a 403 from Paystack would surface as a 403
     * from us and read as an auth problem on our own API.
     */
    readonly upstreamStatus: number,
  ) {
    super(message);
    this.name = 'PaystackApiError';
  }
}

export function isPaystackConfigured(): boolean {
  return Boolean(env.PAYSTACK_SECRET_KEY);
}

function secretKey(): string {
  if (!env.PAYSTACK_SECRET_KEY) throw new PaystackNotConfiguredError();
  return env.PAYSTACK_SECRET_KEY;
}

export interface InitializeTransactionInput {
  email: string;
  /** Minor units: kobo for NGN, cents for USD. */
  amountMinor: number;
  currency: string;
  /** Our own idempotency key, echoed back on the webhook. */
  reference: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
}

export interface InitializeTransactionResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

/**
 * Create a Paystack transaction and get the hosted checkout URL.
 *
 * The reference is ours, not Paystack's, so the row exists in our database
 * before the customer ever reaches the payment page — a webhook can then never
 * arrive for a payment we have no record of.
 */
export async function initializeTransaction(
  input: InitializeTransactionInput,
): Promise<InitializeTransactionResult> {
  const response = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: input.email,
      amount: input.amountMinor,
      currency: input.currency,
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: input.metadata,
    }),
  });

  // Read as text first. Paystack does not always answer with JSON on an error
  // (an auth failure can come back as HTML), and .json() would throw and hide
  // whatever it actually said.
  const rawBody = await response.text();

  interface InitializeResponse {
    status?: boolean;
    message?: string;
    data?: { authorization_url?: string; access_code?: string; reference?: string };
  }

  let payload: InitializeResponse | null = null;
  try {
    payload = JSON.parse(rawBody) as InitializeResponse;
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.status || !payload.data?.authorization_url) {
    throw new PaystackApiError(
      payload?.message ?? `Paystack returned ${response.status}: ${rawBody.slice(0, 300)}`,
      response.status,
    );
  }

  return {
    authorizationUrl: payload.data.authorization_url,
    accessCode: payload.data.access_code ?? '',
    reference: payload.data.reference ?? input.reference,
  };
}

/**
 * Verify a webhook came from Paystack.
 *
 * Paystack signs the RAW request body with HMAC SHA-512 keyed on the secret
 * key. It must be the raw bytes: re-serialising the parsed JSON reorders or
 * reformats it and the signature stops matching.
 *
 * Compared in constant time — a plain `===` leaks how much of a forged
 * signature was correct through timing, which is enough to construct one byte
 * by byte.
 */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;

  const expected = createHmac('sha512', secretKey()).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(signature, 'utf8');

  // timingSafeEqual throws on a length mismatch, which would itself be a
  // timing signal, so the lengths are checked first and identically.
  if (expectedBuffer.length !== providedBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export interface PaystackWebhookEvent {
  event: string;
  data: {
    reference: string;
    status: string;
    amount: number;
    currency: string;
  };
}
