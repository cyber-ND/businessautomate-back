import { env } from '../../env.js';
import type { Audit } from '../ai-engine/audit-schema.js';
import {
  formatMinorUnits,
  formatMoney,
  priceCurrencyFor,
  priceMinorFor,
} from '../intake/currency.js';

// Emails are written the way the report is: their numbers, their words, no
// marketing voice. The whole persuasive weight of a follow-up is that it quotes
// what we already found for THIS business — a generic "come back and buy" is
// both less effective and more likely to be marked as spam.
//
// Plain text ships alongside every HTML body. Some clients render text only,
// and a text part measurably improves deliverability.

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

function reportUrl(reportId: string): string {
  return `${env.WEB_APP_URL}/report/${reportId}`;
}

// Inline styles only: Gmail and Outlook strip <style> blocks, so a stylesheet
// would render as unstyled text for most recipients.
const COLORS = {
  ink: '#0F172A',
  body: '#334155',
  muted: '#64748B',
  gold: '#A16207',
  rule: '#E2E8F0',
};

function layout(bodyHtml: string): string {
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#F8FAFC;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid ${COLORS.rule};border-radius:8px;">
        <tr><td style="padding:32px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${COLORS.body};font-size:16px;line-height:1.6;">
          ${bodyHtml}
        </td></tr>
      </table>
      <p style="max-width:560px;margin:16px auto 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:${COLORS.muted};text-align:left;">
        You received this because you requested a business audit. Not expecting it? Ignore this email and we will not write again.
      </p>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
  <tr><td style="background:${COLORS.gold};border-radius:6px;">
    <a href="${href}" style="display:inline-block;padding:14px 24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#FFFFFF;text-decoration:none;">${label}</a>
  </td></tr>
</table>`;
}

function headline(text: string): string {
  return `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:${COLORS.ink};">${text}</h1>`;
}

// Audit figures and the price are both in the audit's currency, but they are not
// stored the same way: audit amounts are whole units produced by a model, while
// prices are integers in minor units so money never touches a float. Two helpers
// rather than one, so a kobo value can never be rendered as if it were naira.

function money(audit: Audit, amount: number): string {
  return formatMoney(amount, audit.currency);
}

function price(audit: Audit): string {
  // The charged currency, which is the audit's own wherever Paystack accepts it.
  const currency = priceCurrencyFor(audit.currency);
  return formatMinorUnits(priceMinorFor(currency), currency);
}

function describeFindings(audit: Audit): string {
  const { opportunityCount, monthlySavings, hoursSavedPerWeek } = audit.totals;
  return `${opportunityCount} ${
    opportunityCount === 1 ? 'opportunity' : 'opportunities'
  } worth about ${money(audit, monthlySavings)}/month and ${hoursSavedPerWeek} hours a week`;
}

/** Sent as soon as generation finishes. The visitor may have closed the tab. */
export function reportReadyEmail(params: {
  reportId: string;
  businessName: string | null;
  audit: Audit;
}): EmailContent {
  const { reportId, businessName, audit } = params;
  const who = businessName ? ` for ${businessName}` : '';
  const findings = describeFindings(audit);
  const url = reportUrl(reportId);

  // The top-ranked problem goes in the body. It is the single most convincing
  // thing we have, and it proves the audit is about them before they click.
  const topProblem = audit.opportunities.find((o) => o.rank === 1) ?? audit.opportunities[0];

  return {
    subject: `Your audit found ${money(audit, audit.totals.monthlySavings)}/month${who}`,
    html: layout(`
      ${headline('Your audit is ready')}
      <p style="margin:0 0 16px;">We found ${findings}.</p>
      ${
        topProblem
          ? `<p style="margin:0 0 8px;color:${COLORS.muted};font-size:14px;">The biggest one:</p>
             <p style="margin:0 0 16px;padding-left:16px;border-left:3px solid ${COLORS.rule};">${topProblem.problem}</p>`
          : ''
      }
      ${button(url, 'Read your audit')}
      <p style="margin:0;font-size:14px;color:${COLORS.muted};">Every problem we found is yours to read for free. The fixes, the tools and the 90-day plan are in the full report.</p>
    `),
    text: [
      'Your audit is ready.',
      '',
      `We found ${findings}.`,
      ...(topProblem ? ['', 'The biggest one:', topProblem.problem] : []),
      '',
      `Read it here: ${url}`,
      '',
      'Every problem we found is yours to read for free. The fixes, the tools and the 90-day plan are in the full report.',
    ].join('\n'),
  };
}

/** Sent when payment unlocks the report. */
export function reportUnlockedEmail(params: {
  reportId: string;
  businessName: string | null;
  audit: Audit;
}): EmailContent {
  const { reportId, businessName, audit } = params;
  const url = reportUrl(reportId);
  const toolCount = new Set(
    audit.opportunities.flatMap((o) => o.tools.map((tool) => tool.name)),
  ).size;

  return {
    subject: `Your full report is unlocked${businessName ? ` — ${businessName}` : ''}`,
    html: layout(`
      ${headline('Your full report is unlocked')}
      <p style="margin:0 0 16px;">Thank you. Every fix is now visible: ${toolCount} named ${
        toolCount === 1 ? 'tool' : 'tools'
      } with pricing, the first step for each opportunity, and your 30/60/90-day plan.</p>
      ${button(url, 'Open your full report')}
      <p style="margin:0 0 16px;font-size:14px;">Start with the 30-day list. It is ordered so the quick wins come first — bank a visible result before attempting anything hard.</p>
      <p style="margin:0;font-size:14px;color:${COLORS.muted};">Would rather we implemented it for you? Reply to this email and we will take a look.</p>
    `),
    text: [
      'Your full report is unlocked.',
      '',
      `Thank you. Every fix is now visible: ${toolCount} named tool(s) with pricing, the first step for each opportunity, and your 30/60/90-day plan.`,
      '',
      `Open it here: ${url}`,
      '',
      'Start with the 30-day list. It is ordered so the quick wins come first.',
      '',
      'Would rather we implemented it for you? Reply to this email.',
    ].join('\n'),
  };
}

/**
 * Nudges a non-payer, quoting their own numbers.
 *
 * `attempt` is 1-indexed. The second nudge is deliberately shorter and leads
 * with a single concrete problem rather than the totals — repeating the same
 * pitch louder does not work, and this is the last one either way.
 */
export function followUpEmail(params: {
  reportId: string;
  businessName: string | null;
  audit: Audit;
  attempt: number;
}): EmailContent {
  const { reportId, businessName, audit, attempt } = params;
  const url = reportUrl(reportId);
  const unlockPrice = price(audit);
  const total = money(audit, audit.totals.monthlySavings);

  if (attempt >= 2) {
    const top = audit.opportunities.find((o) => o.rank === 1) ?? audit.opportunities[0];
    const cost = top ? money(audit, top.monthlyCost) : total;
    const toolCost = top
      ? money(
          audit,
          top.tools.reduce((sum, tool) => sum + tool.monthlyCost, 0),
        )
      : null;

    return {
      subject: `${cost}/month, still leaking`,
      html: layout(`
        ${headline('One thing, before we leave you alone')}
        ${
          top
            ? `<p style="margin:0 0 16px;padding-left:16px;border-left:3px solid ${COLORS.rule};">${top.problem}</p>
               <p style="margin:0 0 16px;">That one costs about ${cost} a month. The fix is a ${toolCost}/month tool and an afternoon of setup.</p>`
            : `<p style="margin:0 0 16px;">Your audit found ${total} a month in recoverable losses.</p>`
        }
        ${button(url, `Unlock the full report — ${unlockPrice}`)}
        <p style="margin:0;font-size:14px;color:${COLORS.muted};">This is the last email we will send about this audit.</p>
      `),
      text: [
        'One thing, before we leave you alone.',
        '',
        ...(top
          ? [top.problem, '', `That one costs about ${cost} a month. The fix is a ${toolCost}/month tool.`]
          : [`Your audit found ${total} a month in recoverable losses.`]),
        '',
        `Unlock the full report (${unlockPrice}): ${url}`,
        '',
        'This is the last email we will send about this audit.',
      ].join('\n'),
    };
  }

  return {
    subject: `Your audit found ${total}/month — the report is still waiting`,
    html: layout(`
      ${headline(`${total} a month${businessName ? `, at ${businessName}` : ''}`)}
      <p style="margin:0 0 16px;">That is what your audit found across ${describeFindings(audit)}. You have read the problems. The fixes are still locked.</p>
      <p style="margin:0 0 16px;">The full report names every tool with its price, gives you the first step for each fix, and lays out a 30/60/90-day plan.</p>
      ${button(url, `Unlock the full report — ${unlockPrice}`)}
      <p style="margin:0;font-size:14px;color:${COLORS.muted};">One payment, this report, no subscription.</p>
    `),
    text: [
      `${total} a month.`,
      '',
      `That is what your audit found across ${describeFindings(audit)}. You have read the problems. The fixes are still locked.`,
      '',
      'The full report names every tool with its price, gives you the first step for each fix, and lays out a 30/60/90-day plan.',
      '',
      `Unlock it (${unlockPrice}): ${url}`,
      '',
      'One payment, this report, no subscription.',
    ].join('\n'),
  };
}
