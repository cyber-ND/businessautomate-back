import type { Audit, Opportunity } from '../ai-engine/audit-schema.js';

// "Show the disease and its cost, never the prescription."
//
// The full audit is generated once and stored once. This module is the only
// place that decides what a given viewer may see, and it is a pure function over
// a stored audit — never a second generation. A free viewer and a paid viewer
// are looking at the same underlying document.
//
// Free: every problem, personally worded, with what it costs. The total prize.
// And proof a fix exists — the price of the tool, but not its name.
// Locked: tool names, pricing detail, fit rationale, implementation steps, and
// the roadmap.

export interface FreeOpportunity {
  rank: number;
  problem: string;
  monthlyCostUsd: number;
  hoursLostPerWeek: number;
  difficulty: Opportunity['difficulty'];
  monthlySavingsUsd: number;
  hoursSavedPerWeek: number;
  /**
   * The teaser: what the fix costs per month, with the tools themselves
   * withheld. Zero is not a weaker hook than a number — "the fix costs you
   * nothing, you just need to know which tool" is arguably the stronger one —
   * so the copy for that case is the frontend's job, not a reason to hide it.
   */
  solutionToolCostUsd: number;
  /** How many tools the fix needs, so the locked card can render that many rows. */
  toolCount: number;
}

export interface FreeAudit {
  locked: true;
  businessSummary: string;
  opportunities: FreeOpportunity[];
  totals: Audit['totals'];
}

export interface PaidAudit extends Audit {
  locked: false;
}

export type GatedAudit = FreeAudit | PaidAudit;

function toFreeOpportunity(opportunity: Opportunity): FreeOpportunity {
  return {
    rank: opportunity.rank,
    problem: opportunity.problem,
    monthlyCostUsd: opportunity.monthlyCostUsd,
    hoursLostPerWeek: opportunity.hoursLostPerWeek,
    difficulty: opportunity.difficulty,
    monthlySavingsUsd: opportunity.monthlySavingsUsd,
    hoursSavedPerWeek: opportunity.hoursSavedPerWeek,
    solutionToolCostUsd: opportunity.tools.reduce((sum, tool) => sum + tool.monthlyCostUsd, 0),
    toolCount: opportunity.tools.length,
  };
}

/**
 * Shape a stored audit for the viewer.
 *
 * `paid` must be derived from `Report.paidAt`, which only a signature-verified
 * Paystack webhook sets. It must never come from anything the client supplies.
 */
export function gateAudit(audit: Audit, paid: boolean): GatedAudit {
  if (paid) {
    return { ...audit, locked: false };
  }

  return {
    locked: true,
    businessSummary: audit.businessSummary,
    opportunities: [...audit.opportunities]
      .sort((a, b) => a.rank - b.rank)
      .map(toFreeOpportunity),
    totals: audit.totals,
  };
}
