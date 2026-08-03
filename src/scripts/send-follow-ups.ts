// Nudge non-payers, quoting their own numbers back at them.
//
// Meant to be run on a schedule (Railway cron, or any scheduler). Selection is
// conservative — completed, unpaid, under the nudge cap, quiet for at least
// FOLLOW_UP_DELAY_HOURS — so running it more often than needed is harmless.
//
//   npm run email:follow-ups -- --dry-run   # log what would be sent
//   npm run email:follow-ups                # actually send

import '../load-env.js';

const { runFollowUpSweep } = await import('../modules/email/service.js');
const { prisma } = await import('../db.js');
const { env } = await import('../env.js');

const dryRun = process.argv.includes('--dry-run');

console.log(
  `sweep: delay=${env.FOLLOW_UP_DELAY_HOURS}h max=${env.FOLLOW_UP_MAX} mode=${dryRun ? 'dry run' : 'live'}`,
);

const result = await runFollowUpSweep({ dryRun });

console.log(`considered : ${result.considered}`);
console.log(`${dryRun ? 'would send' : 'sent'}      : ${result.sent}`);
console.log(`skipped    : ${result.skipped}`);

await prisma.$disconnect();
