// Simulate a Paystack `charge.success` webhook against the local app.
//
// Unlocks a report without real money, and exercises the signature check and
// the idempotency guard — the two parts of the payment path that must not be
// wrong. Runs entirely in-process via app.inject(), so no server and no
// network are needed.
//
//   npm run payment:simulate                 # newest completed report
//   npm run payment:simulate -- <reportId>
//   npm run payment:simulate -- <reportId> --test-guards
//
// --test-guards additionally sends a forged signature and a replay, asserting
// that the first is rejected and the second does not unlock twice.

import '../load-env.js';

// Signature verification needs a key. Any value works locally because the same
// key both signs and verifies here; production supplies the real one.
process.env.PAYSTACK_SECRET_KEY ??= 'sk_test_local_simulation_only';

const { createHmac } = await import('node:crypto');
const { buildApp } = await import('../app.js');
const { prisma } = await import('../db.js');

const args = process.argv.slice(2);
const testGuards = args.includes('--test-guards');
const explicitId = args.find((arg) => !arg.startsWith('--'));

const secret = process.env.PAYSTACK_SECRET_KEY;

function sign(body: string): string {
  return createHmac('sha512', secret).update(Buffer.from(body, 'utf8')).digest('hex');
}

const report = explicitId
  ? await prisma.report.findUnique({ where: { id: explicitId } })
  : await prisma.report.findFirst({
      where: { status: 'COMPLETED', paidAt: null },
      orderBy: { createdAt: 'desc' },
    });

if (!report) {
  console.error(
    explicitId
      ? `No report with id ${explicitId}.`
      : 'No unpaid COMPLETED report found. Run the wizard flow first, or pass a report id.',
  );
  process.exit(1);
}

console.log(`report  : ${report.id} (${report.status}, paidAt=${report.paidAt?.toISOString() ?? 'null'})`);

const reference = `sim_${report.id}_${Date.now()}`;

await prisma.payment.create({
  data: {
    reportId: report.id,
    reference,
    amountMinor: 4900,
    currency: 'USD',
    status: 'PENDING',
  },
});
console.log(`payment : ${reference} (PENDING)`);

const body = JSON.stringify({
  event: 'charge.success',
  data: { reference, status: 'success', amount: 4900, currency: 'USD' },
});

const app = await buildApp();

async function post(signature: string) {
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/paystack',
    headers: { 'content-type': 'application/json', 'x-paystack-signature': signature },
    payload: body,
  });
}

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

if (testGuards) {
  console.log('\n--- guards ---');
  const forged = await post('deadbeef'.repeat(16));
  check('forged signature rejected', forged.statusCode, 401);

  const stillLocked = await prisma.report.findUnique({ where: { id: report.id } });
  check('report still locked after forgery', stillLocked?.paidAt === null, true);
}

console.log('\n--- valid webhook ---');
const first = await post(sign(body));
check('accepted', first.statusCode, 200);
check('not previously processed', first.json().alreadyProcessed, false);

const unlocked = await prisma.report.findUnique({ where: { id: report.id } });
check('report unlocked', unlocked?.paidAt !== null, true);
const unlockedAt = unlocked?.paidAt?.toISOString();

if (testGuards) {
  console.log('\n--- replay ---');
  const replay = await post(sign(body));
  check('replay accepted', replay.statusCode, 200);
  check('replay recognised as duplicate', replay.json().alreadyProcessed, true);

  const after = await prisma.report.findUnique({ where: { id: report.id } });
  check('paidAt unchanged by replay', after?.paidAt?.toISOString(), unlockedAt);
}

await app.close();
await prisma.$disconnect();

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
