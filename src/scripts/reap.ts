// Run the stalled-report sweep once and report what it did.
//
// The server sweeps on its own (at boot and on an interval), so this is for
// operating on it by hand: after an incident, or to confirm a suspicious report
// is being recovered rather than silently stuck.
//
//   npm run reap

import '../load-env.js';

const { reapStalledReports } = await import('../modules/reports/reaper.js');
const { prisma } = await import('../db.js');
const { env } = await import('../env.js');

console.log(
  `sweeping: stale after ${env.REPORT_STALE_AFTER_MINUTES}m, max ${env.REPORT_MAX_ATTEMPTS} attempts`,
);

const result = await reapStalledReports();

console.log(`resumed : ${result.resumed}`);
console.log(`failed  : ${result.failed}`);

if (result.resumed > 0) {
  // Generation is fire-and-forget, so exiting immediately would kill the work
  // this sweep just started. Wait long enough for the model calls to finish.
  console.log('\nwaiting for resumed reports to finish...');
  await new Promise((resolve) => setTimeout(resolve, 150_000));
}

await prisma.$disconnect();
