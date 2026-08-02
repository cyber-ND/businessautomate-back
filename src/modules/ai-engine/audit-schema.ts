import { z } from 'zod';

// The audit contract, enforced by the API through structured outputs. A response
// that reaches our code has already been validated against this schema, so there
// is no JSON parsing to do and no repair path to write.
//
// Every `.describe()` is sent to the model as part of the schema, so these
// strings are prompt surface rather than comments. Keep them instructive.
//
// Numeric and array bounds are deliberately loose. The SDK strips JSON Schema
// constraints the API does not support and validates them client-side instead,
// which means a tight bound turns a slightly-off-spec but perfectly usable audit
// into a thrown error. The prompt asks for exactly five opportunities; the
// schema tolerates a different count so one extra never fails a paid report.

export const ToolRecommendationSchema = z
  .object({
    name: z
      .string()
      .describe('Exact product name, e.g. "Zoho Books" — never a category like "an accounting tool".'),
    monthlyCostUsd: z
      .number()
      .describe(
        'Realistic monthly cost in USD for THIS business at THIS size. Use 0 only when a free tier genuinely covers their volume.',
      ),
    whyThisFits: z
      .string()
      .describe(
        'One or two sentences on why this specific tool suits their business type, size, budget and country. Not a feature list.',
      ),
  })
  .strict();

export const OpportunitySchema = z
  .object({
    rank: z
      .number()
      .int()
      .describe('1 is the highest-return opportunity. Rank by savings weighed against difficulty and tool cost.'),

    // ---- Visible on the free report: the disease and what it costs. ----
    problem: z
      .string()
      .describe(
        'The specific operational leak, written back to the owner in their own terms and referencing details they actually gave. Never generic.',
      ),
    monthlyCostUsd: z
      .number()
      .describe(
        'What this problem costs them per month right now, in USD, anchored to their stated revenue and admin hours. Be conservative: a number they recognise as fair beats an impressive one.',
      ),
    hoursLostPerWeek: z.number().describe('Hours per week currently lost to this problem.'),
    difficulty: z
      .enum(['EASY', 'MEDIUM', 'HARD'])
      .describe('EASY: under a day, no technical help. MEDIUM: about a week, or outside help. HARD: a project.'),
    monthlySavingsUsd: z
      .number()
      .describe('Realistic monthly saving in USD once fixed, net of the recommended tool cost.'),
    hoursSavedPerWeek: z.number().describe('Hours per week freed once fixed.'),

    // ---- Locked behind payment: the prescription. ----
    solution: z
      .string()
      .describe('Concretely what to change. Describe the new workflow, not the aspiration.'),
    tools: z
      .array(ToolRecommendationSchema)
      .describe('One to three named tools that solve this. Prefer free tiers for small teams.'),
    firstStep: z
      .string()
      .describe('The single first action they can take today, small enough to finish in one sitting.'),
  })
  .strict();

export const AuditTotalsSchema = z
  .object({
    monthlySavingsUsd: z.number().describe('Sum of monthlySavingsUsd across all opportunities.'),
    hoursSavedPerWeek: z.number().describe('Sum of hoursSavedPerWeek across all opportunities.'),
    opportunityCount: z.number().int().describe('Number of opportunities found.'),
  })
  .strict();

export const RoadmapSchema = z
  .object({
    days30: z.array(z.string()).describe('Quick wins first. Two to four concrete actions.'),
    days60: z.array(z.string()).describe('Two to four actions building on the first 30 days.'),
    days90: z.array(z.string()).describe('Two to four actions that finish the job.'),
  })
  .strict();

export const AuditSchema = z
  .object({
    businessSummary: z
      .string()
      .describe(
        'Two or three sentences proving you understood their business, referencing specifics they gave you. This is the first thing they read and it decides whether they trust the rest.',
      ),
    opportunities: z
      .array(OpportunitySchema)
      .describe('Exactly five opportunities, ranked by return, rank 1 first.'),
    totals: AuditTotalsSchema,
    roadmap: RoadmapSchema,
  })
  .strict();

export type ToolRecommendation = z.infer<typeof ToolRecommendationSchema>;
export type Opportunity = z.infer<typeof OpportunitySchema>;
export type AuditTotals = z.infer<typeof AuditTotalsSchema>;
export type Roadmap = z.infer<typeof RoadmapSchema>;
export type Audit = z.infer<typeof AuditSchema>;

// ---------------------------------------------------------------------------
// Adaptive follow-up triage
// ---------------------------------------------------------------------------

export const TriageSchema = z
  .object({
    ready: z
      .boolean()
      .describe(
        'True if the intake is already rich enough to write a specific, non-generic audit. Default to true: an unnecessary question costs more trust than a slightly thinner report.',
      ),
    question: z
      .string()
      .nullable()
      .describe(
        'When ready is false, the single most valuable follow-up question, phrased conversationally and referencing what they already said. Null when ready is true.',
      ),
    reason: z
      .string()
      .describe('One short sentence on why this matters, for our logs. Never shown to the visitor.'),
  })
  .strict();

export type Triage = z.infer<typeof TriageSchema>;

/**
 * Totals are the headline numbers on the paywall screen ("5 opportunities worth
 * ~$2,100/month"), so they must equal the opportunities they claim to summarise.
 * The model computes them and usually gets it right, but a summed figure that
 * contradicts the visible line items is the single most trust-destroying bug
 * this product could ship — so we recompute rather than trust.
 */
export function recomputeTotals(audit: Audit): Audit {
  const monthlySavingsUsd = audit.opportunities.reduce((sum, o) => sum + o.monthlySavingsUsd, 0);
  const hoursSavedPerWeek = audit.opportunities.reduce((sum, o) => sum + o.hoursSavedPerWeek, 0);

  return {
    ...audit,
    totals: {
      monthlySavingsUsd: Math.round(monthlySavingsUsd),
      // One decimal place: "11.5 hrs/week" reads as measured, "11.4999" does not.
      hoursSavedPerWeek: Math.round(hoursSavedPerWeek * 10) / 10,
      opportunityCount: audit.opportunities.length,
    },
  };
}
