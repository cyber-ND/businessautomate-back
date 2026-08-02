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

// Thinking is on by default on these models, and max_tokens caps thinking AND
// response text TOGETHER. A budget sized for the visible audit alone truncates
// mid-JSON: at 16k, Sonnet 5 on high effort spent so much of it reasoning that
// the document was cut off around 7.5k characters in. Opus 5 fit in 16k, Sonnet
// did not, so the ceiling is set by the hungriest model rather than the average.
//
// At this budget the SDK refuses non-streaming requests outright — it estimates
// they could exceed ten minutes and an idle connection would drop first — so the
// audit call streams and collects the final message.
const AUDIT_MAX_TOKENS = 32_000;

// Triage is one judgment call, not a document.
const TRIAGE_MAX_TOKENS = 2_000;

type Effort = typeof env.AI_EFFORT_PAID;

function effortFor(tier: ReportTier): Effort {
  return tier === 'PAID' ? env.AI_EFFORT_PAID : env.AI_EFFORT_FREE;
}

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

    // Streaming, then collecting the final message, for two reasons.
    //
    // First, the SDK rejects a non-streaming request at this token budget: it
    // estimates the call could outlast an idle HTTP connection.
    //
    // Second, this deliberately avoids messages.parse(). That helper decodes the
    // JSON inside the SDK and throws on malformed output, which fires BEFORE we
    // can read stop_reason — so a response truncated at the token ceiling
    // surfaces as an opaque "Unterminated string in JSON at position 7508"
    // instead of the truncation it actually is. Reading the raw message lets us
    // classify the failure properly, which matters because TRUNCATED is worth
    // retrying and REFUSED is not.
    let response;
    try {
      response = await this.client.messages
        .stream({
          model,
          max_tokens: AUDIT_MAX_TOKENS,
          output_config: {
            effort: effortFor(tier),
            format: zodOutputFormat(AuditSchema),
          },
          system: AUDIT_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildAuditUserPrompt(intake, followUps) }],
        })
        .finalMessage();
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
        `Audit hit the ${AUDIT_MAX_TOKENS}-token ceiling before completing. ` +
          `Thinking and output share this budget, so raising it or lowering effort both help.`,
        'TRUNCATED',
      );
    }

    // With thinking enabled the response opens with thinking blocks, so the
    // audit is not necessarily content[0].
    const text = response.content.find((block) => block.type === 'text')?.text;

    if (!text) {
      throw new AuditGenerationError(
        `Model returned no text block (stop_reason=${response.stop_reason ?? 'unknown'}).`,
        'EMPTY',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new AuditGenerationError(
        `Audit was not valid JSON despite a ${response.stop_reason} stop reason.`,
        'EMPTY',
        { cause: error },
      );
    }

    // The API enforces the schema, so this should always pass. It is here
    // because "should always" is not "does always", and a malformed audit
    // reaching the report page is worse than a clean failure we can retry.
    const validated = AuditSchema.safeParse(parsed);
    if (!validated.success) {
      throw new AuditGenerationError(
        `Audit did not match the schema: ${validated.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
        'EMPTY',
        { cause: validated.error },
      );
    }

    return {
      // Totals are recomputed rather than trusted: they are the headline figure
      // on the paywall screen, and a total that contradicts the visible line
      // items would be the most trust-destroying bug we could ship.
      audit: recomputeTotals(validated.data),
      model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
