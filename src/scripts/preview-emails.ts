// Render every email against a real stored audit and write them to disk.
//
// Email is the one part of this system you cannot judge from code — the numbers
// have to read right in the actual copy. This renders all four messages from a
// real report so they can be opened in a browser, without sending anything.
//
//   npm run email:preview              # newest completed report
//   npm run email:preview -- <reportId>

import '../load-env.js';

const { mkdir, writeFile } = await import('node:fs/promises');
const { join } = await import('node:path');

const { prisma } = await import('../db.js');
const { AuditSchema } = await import('../modules/ai-engine/audit-schema.js');
const { followUpEmail, reportReadyEmail, reportUnlockedEmail } = await import(
  '../modules/email/templates.js'
);

const explicitId = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

const report = explicitId
  ? await prisma.report.findUnique({ where: { id: explicitId } })
  : await prisma.report.findFirst({
      where: { status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
    });

if (!report) {
  console.error('No completed report found. Generate one first.');
  process.exit(1);
}

const audit = AuditSchema.safeParse(report.result);
if (!audit.success) {
  console.error(`Report ${report.id} has no readable audit.`);
  process.exit(1);
}

const base = { reportId: report.id, businessName: report.businessName, audit: audit.data };

const emails = {
  'report-ready': reportReadyEmail(base),
  'report-unlocked': reportUnlockedEmail(base),
  'follow-up-1': followUpEmail({ ...base, attempt: 1 }),
  'follow-up-2': followUpEmail({ ...base, attempt: 2 }),
};

const outDir = join(process.cwd(), 'email-preview');
await mkdir(outDir, { recursive: true });

for (const [name, content] of Object.entries(emails)) {
  await writeFile(join(outDir, `${name}.html`), content.html, 'utf8');
  await writeFile(join(outDir, `${name}.txt`), `Subject: ${content.subject}\n\n${content.text}`, 'utf8');
  console.log(`${name.padEnd(16)} ${content.subject}`);
}

console.log(`\nWritten to ${outDir}`);
await prisma.$disconnect();
