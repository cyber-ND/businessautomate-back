import { z } from 'zod';

// What the wizard collects: structured taps for facts, free text for pain.
//
// Only email, businessType and painPoints are required. The wizard is a
// four-minute conversation, not a form — a visitor who skips the revenue
// question should still get an audit, and the prompt is written to reason from
// whatever is present rather than demanding a full set.

export const TeamSizeSchema = z.enum(['SOLO', 'TWO_TO_FIVE', 'SIX_TO_TWENTY', 'TWENTYONE_PLUS']);

export const RevenueRangeSchema = z.enum([
  'UNDER_5K',
  'FIVE_TO_20K',
  'TWENTY_TO_50K',
  'FIFTY_TO_200K',
  'OVER_200K',
  'PREFER_NOT_TO_SAY',
]);

export const IntakeSchema = z.object({
  email: z.string().trim().email().max(200),
  businessName: z.string().trim().min(1).max(120).optional(),

  // Free text rather than a dropdown, so we are not limited to the industries
  // we happened to guess at.
  businessType: z.string().trim().min(2).max(120),

  country: z.string().trim().min(2).max(60).optional(),
  teamSize: TeamSizeSchema.optional(),
  monthlyRevenueRange: RevenueRangeSchema.optional(),
  adminHoursPerWeek: z.number().min(0).max(168).optional(),
  currentTools: z.array(z.string().trim().min(1).max(80)).max(30).default([]),

  // The free-text vent. This is what makes an audit specific rather than
  // generic, which is why it is the one long-form field we insist on.
  painPoints: z
    .string()
    .trim()
    .min(10, 'Tell us a little more about what eats your time.')
    .max(4000),
});

export type Intake = z.infer<typeof IntakeSchema>;
export type TeamSize = z.infer<typeof TeamSizeSchema>;
export type RevenueRange = z.infer<typeof RevenueRangeSchema>;

export const FollowUpSchema = z.object({
  question: z.string().min(1).max(500),
  answer: z.string().trim().min(1).max(2000),
});

export type FollowUp = z.infer<typeof FollowUpSchema>;

// Hard cap on adaptive follow-ups. Past this we audit with what we have —
// a wizard that keeps asking stops feeling like a consultant and starts
// feeling like a form.
export const MAX_FOLLOW_UPS = 3;

// Human-readable labels used when rendering the intake into a prompt. Sending
// "TWO_TO_FIVE" to the model wastes its attention on decoding our constants.
const TEAM_SIZE_LABELS: Record<TeamSize, string> = {
  SOLO: 'just the owner',
  TWO_TO_FIVE: '2-5 people',
  SIX_TO_TWENTY: '6-20 people',
  TWENTYONE_PLUS: '21 or more people',
};

const REVENUE_LABELS: Record<RevenueRange, string> = {
  UNDER_5K: 'under $5,000/month',
  FIVE_TO_20K: '$5,000-$20,000/month',
  TWENTY_TO_50K: '$20,000-$50,000/month',
  FIFTY_TO_200K: '$50,000-$200,000/month',
  OVER_200K: 'over $200,000/month',
  PREFER_NOT_TO_SAY: 'declined to say',
};

export function describeTeamSize(value: TeamSize | undefined): string {
  return value ? TEAM_SIZE_LABELS[value] : 'not stated';
}

export function describeRevenue(value: RevenueRange | undefined): string {
  return value ? REVENUE_LABELS[value] : 'not stated';
}
