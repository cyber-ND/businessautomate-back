// Generate one real audit from a fixture and print it.
//
// This exists because the audit IS the product: before any wizard, report page
// or paywall is worth building, we need to read actual output and judge whether
// a business owner would pay for it.
//
//   npm run audit             # lists fixtures
//   npm run audit -- salon    # generates an audit for the salon fixture
//   npm run audit -- salon --json

import '../load-env.js';

// The AI engine imports the shared config module, which requires DATABASE_URL.
// This script never opens a connection, so a placeholder keeps it runnable
// before Postgres has been provisioned.
process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost:5432/unused';

const { getAiProvider } = await import('../modules/ai-engine/index.js');
const { fixtures, fixtureNames } = await import('./fixtures.js');
const { MAX_FOLLOW_UPS } = await import('../modules/intake/schema.js');
const { env } = await import('../env.js');

type Tier = 'FREE' | 'PAID';

// Per-million-token rates, for a rough cost read on each run. Sonnet 5 carries
// introductory pricing through 2026-08-31 ($2/$10), reverting to $3/$15 after —
// so this figure drifts on that date and is indicative, not billing.
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const rate = PRICING[model];
  if (!rate) return null;
  return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
}

function money(value: number): string {
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function rule(label = ''): void {
  const line = '─'.repeat(74);
  console.log(label ? `\n${label}\n${line}` : line);
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const tier: Tier = args.includes('--free') ? 'FREE' : 'PAID';
const name = args.find((arg) => !arg.startsWith('--'));

if (!name) {
  console.log(`Usage: npm run audit -- <fixture> [--free] [--json]\n`);
  console.log(`Fixtures: ${fixtureNames.join(', ')}`);
  console.log(`\nDefaults to the PAID tier (${env.AI_MODEL_PAID}).`);
  console.log(`Pass --free to use the free-tier model (${env.AI_MODEL_FREE}).`);
  process.exit(0);
}

const intake = fixtures[name];
if (!intake) {
  console.error(`Unknown fixture "${name}". Available: ${fixtureNames.join(', ')}`);
  process.exit(1);
}

const provider = getAiProvider();

console.log(`Fixture:  ${name} (${intake.businessType})`);
console.log(`Tier:     ${tier} → ${tier === 'PAID' ? env.AI_MODEL_PAID : env.AI_MODEL_FREE}`);

// --- Step 1: adaptive triage ------------------------------------------------
rule('TRIAGE');
const startedTriage = Date.now();
const triage = await provider.triageIntake(intake);
console.log(`ready:    ${triage.ready}`);
console.log(`question: ${triage.question ?? '(none)'}`);
console.log(`reason:   ${triage.reason}`);
console.log(`took:     ${((Date.now() - startedTriage) / 1000).toFixed(1)}s`);

if (!triage.ready) {
  console.log(
    `\nIn the real funnel the visitor would answer this now (capped at ${MAX_FOLLOW_UPS}),\nand the answer would be passed into the audit. Generating without it.`,
  );
}

// --- Step 2: the audit ------------------------------------------------------
rule('AUDIT');
const startedAudit = Date.now();
const result = await provider.generateAudit(intake, [], tier);
const elapsedSeconds = (Date.now() - startedAudit) / 1000;

if (asJson) {
  console.log(JSON.stringify(result.audit, null, 2));
} else {
  const { audit } = result;

  console.log(audit.businessSummary);

  console.log(
    `\nTOTAL PRIZE: ${audit.totals.opportunityCount} opportunities worth ` +
      `${money(audit.totals.monthlySavingsUsd)}/month and ${audit.totals.hoursSavedPerWeek} hrs/week`,
  );

  for (const opportunity of audit.opportunities) {
    rule(`#${opportunity.rank}  [${opportunity.difficulty}]`);

    // Everything under FREE is what a non-paying visitor sees. Everything under
    // LOCKED sits behind the paywall. Printed this way so the split can be
    // judged by eye: is the free half tantalising, and is the locked half
    // clearly worth paying for?
    console.log(`FREE   problem:  ${opportunity.problem}`);
    console.log(
      `FREE   costs:    ${money(opportunity.monthlyCostUsd)}/month, ${opportunity.hoursLostPerWeek} hrs/week`,
    );
    console.log(
      `FREE   upside:   ${money(opportunity.monthlySavingsUsd)}/month, ${opportunity.hoursSavedPerWeek} hrs/week`,
    );

    const toolCost = opportunity.tools.reduce((sum, tool) => sum + tool.monthlyCostUsd, 0);
    console.log(
      `FREE   teaser:   a ${money(toolCost)}/month tool fixes this — named in your full report`,
    );

    console.log(`LOCKED solution: ${opportunity.solution}`);
    for (const tool of opportunity.tools) {
      console.log(`LOCKED tool:     ${tool.name} (${money(tool.monthlyCostUsd)}/mo) — ${tool.whyThisFits}`);
    }
    console.log(`LOCKED first:    ${opportunity.firstStep}`);
  }

  rule('LOCKED  ROADMAP');
  for (const [window, items] of [
    ['30 days', audit.roadmap.days30],
    ['60 days', audit.roadmap.days60],
    ['90 days', audit.roadmap.days90],
  ] as const) {
    console.log(`${window}:`);
    for (const item of items) console.log(`  - ${item}`);
  }
}

// --- Step 3: what it cost us ------------------------------------------------
rule('RUN');
const cost = estimateCostUsd(result.model, result.usage.inputTokens, result.usage.outputTokens);
console.log(`model:  ${result.model}`);
console.log(`tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
console.log(`cost:   ${cost === null ? 'unknown model, no rate on file' : `~$${cost.toFixed(4)}`}`);
console.log(`took:   ${elapsedSeconds.toFixed(1)}s`);
