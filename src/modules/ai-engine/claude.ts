import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import { env } from '../../env.js';
import type { FollowUp, Intake } from '../intake/schema.js';
import { AuditSchema, TriageSchema, recomputeTotals, type Triage } from './audit-schema.js';
import {
  AUDIT_SYSTEM_PROMPT,
  TRIAGE_SYSTEM_PROMPT,
  buildAuditUserPrompt,
  buildTriageUserPrompt,
} from './prompt.js';
import {
  AuditGenerationError,
  type AiProvider,
  type AuditResult,
  type ReportTier,
} from './provider.js';

// On Opus 5 thinking is ON by default and max_tokens caps thinking AND response
// text together, so a budget sized only for the visible audit truncates it
// mid-JSON. That surfaces as stop_reason "max_tokens" with a null parsed_output,
// which is why this is sized with room for the model to reason through the
// savings maths as well as write the document.
const AUDIT_MAX_TOKENS = 16_000;

// Triage is one judgment call, not a document.
const TRIAGE_MAX_TOKENS = 2_000;

// Effort is the intelligence-versus-cost dial. The free tier gets `high` too,
// deliberately: the free audit is the entire conversion engine, so
// under-investing there is penny-wise. If free volume outgrows the AI budget,
// dropping FREE to 'medium' is the first lever to pull and it is a one-word
// change here.
const EFFORT_BY_TIER: Record<ReportTier, 'low' | 'medium' | 'high'> = {
  FREE: 'high',
  PAID: 'high',
};

export class ClaudeProvider implements AiProvider {
  readonly name = 'claude';
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    this.client =
      client ??
      new Anthropic({
        apiKey: env.ANTHROPIC_API_KEY,
        // Generation is async and already retryable at the job level, so a few
        // extra in-SDK attempts on a 429 or 529 are much cheaper than showing a
        // visitor a failed audit.
        maxRetries: 3,
      });
  }

  private modelFor(tier: ReportTier): string {
    return tier === 'PAID' ? env.AI_MODEL_PAID : env.AI_MODEL_FREE;
  }

  async triageIntake(intake: Intake, followUps: FollowUp[] = []): Promise<Triage> {
    let response;
    try {
      response = await this.client.messages.parse({
        model: env.AI_MODEL_TRIAGE,
        max_tokens: TRIAGE_MAX_TOKENS,
        output_config: {
          effort: 'low',
          format: zodOutputFormat(TriageSchema),
        },
        system: TRIAGE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildTriageUserPrompt(intake, followUps) }],
      });
    } catch (error) {
      // Triage is an enhancement, not the product. Never block the funnel on it:
      // a visitor who gets no follow-up question still gets an audit.
      return {
        ready: true,
        question: null,
        reason: `triage call failed (${error instanceof Error ? error.message : 'unknown'}); proceeding to audit`,
      };
    }

    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      return {
        ready: true,
        question: null,
        reason: `triage unusable (stop_reason=${response.stop_reason ?? 'unknown'}); proceeding to audit`,
      };
    }

    const triage = response.parsed_output;

    // Guard the one contradictory state the schema cannot express: ready:false
    // with no question would strand the visitor on the follow-up screen forever.
    if (!triage.ready && !triage.question) {
      return { ready: true, question: null, reason: 'triage withheld input without asking anything' };
    }

    return triage;
  }

  async generateAudit(
    intake: Intake,
    followUps: FollowUp[],
    tier: ReportTier,
  ): Promise<AuditResult> {
    const model = this.modelFor(tier);

    let response;
    try {
      response = await this.client.messages.parse({
        model,
        max_tokens: AUDIT_MAX_TOKENS,
        output_config: {
          effort: EFFORT_BY_TIER[tier],
          format: zodOutputFormat(AuditSchema),
        },
        system: AUDIT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildAuditUserPrompt(intake, followUps) }],
      });
    } catch (error) {
      throw new AuditGenerationError(
        `Anthropic request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        'UPSTREAM',
        { cause: error },
      );
    }

    // Check stop_reason before touching content. Opus 5 ships elevated safety
    // classifiers that can decline a request with a normal HTTP 200 and an empty
    // content array, so reading content blind would throw a confusing TypeError
    // instead of a diagnosable failure.
    if (response.stop_reason === 'refusal') {
      throw new AuditGenerationError(
        `Model declined to generate the audit (category: ${response.stop_details?.category ?? 'unknown'}).`,
        'REFUSED',
      );
    }

    if (response.stop_reason === 'max_tokens') {
      throw new AuditGenerationError(
        `Audit hit the ${AUDIT_MAX_TOKENS}-token ceiling before completing.`,
        'TRUNCATED',
      );
    }

    if (!response.parsed_output) {
      throw new AuditGenerationError(
        `Model returned no parseable audit (stop_reason=${response.stop_reason ?? 'unknown'}).`,
        'EMPTY',
      );
    }

    return {
      // Totals are recomputed rather than trusted: they are the headline figure
      // on the paywall screen, and a total that contradicts the visible line
      // items would be the most trust-destroying bug we could ship.
      audit: recomputeTotals(response.parsed_output),
      model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
