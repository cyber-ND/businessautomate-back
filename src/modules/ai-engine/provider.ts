import type { FollowUp, Intake } from '../intake/schema.js';
import type { Audit, Triage } from './audit-schema.js';

// The AI engine sits behind this interface so no other module imports a vendor
// SDK. Claude is the only implementation today; the boundary exists so that
// swapping or adding a model is one new file rather than a search across the
// whole API layer.

export type ReportTier = 'FREE' | 'PAID';

export interface AuditResult {
  audit: Audit;
  /** Exact model id that produced this audit, stored on the report row. */
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface AiProvider {
  readonly name: string;

  /** Decide whether the intake is rich enough to audit, or ask one question. */
  triageIntake(intake: Intake, followUps?: FollowUp[]): Promise<Triage>;

  /** Generate the COMPLETE audit. Gating happens later, in the API layer. */
  generateAudit(intake: Intake, followUps: FollowUp[], tier: ReportTier): Promise<AuditResult>;
}

export type AuditFailureCode = 'REFUSED' | 'TRUNCATED' | 'EMPTY' | 'UPSTREAM';

/** Thrown when the model produced no usable audit. Callers mark the report FAILED. */
export class AuditGenerationError extends Error {
  constructor(
    message: string,
    readonly code: AuditFailureCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AuditGenerationError';
  }
}
