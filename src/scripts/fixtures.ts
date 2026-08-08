import type { Intake } from '../modules/intake/schema.js';

// Real-shaped intakes for exercising the engine before any UI exists. The pain
// points are written the way an owner actually vents, because that is the input
// the prompt is tuned for — a tidy summary would flatter the model and tell us
// nothing about how it handles the real thing.

export const fixtures: Record<string, Intake> = {
  salon: {
    email: 'owner@example.com',
    businessName: 'Glow Hair Studio',
    businessType: 'hair salon and beauty studio',
    country: 'Nigeria',
    teamSize: 'TWO_TO_FIVE',
    monthlyRevenueRange: 'FIVE_TO_20K',
    adminHoursPerWeek: 14,
    currentTools: ['WhatsApp Business', 'Instagram', 'a paper appointment book'],
    painPoints: `Honestly the biggest headache is no-shows. People book on WhatsApp, I write them in the book, then they just don't come and I've already turned away someone else for that slot. Happens maybe 6-8 times a week. I also spend my evenings replying to the same three questions over and over - do you do braids, how much, are you open Sunday. And I have no idea which of my stylists is actually bringing in money because everything is cash or transfer and I just write it in the same book. End of month I'm guessing.`,
  },

  logistics: {
    email: 'ops@example.com',
    businessName: 'SwiftMove Logistics',
    businessType: 'last-mile delivery and dispatch',
    country: 'Nigeria',
    teamSize: 'SIX_TO_TWENTY',
    monthlyRevenueRange: 'TWENTY_TO_50K',
    adminHoursPerWeek: 25,
    currentTools: ['WhatsApp groups', 'Excel', 'Google Maps'],
    painPoints: `We run 11 riders. Every morning I'm in three WhatsApp groups assigning drops by hand and it takes me two hours before anyone even moves. Customers call the office asking where their package is and we have to ring the rider to find out, so my one office person does almost nothing else all day. Riders send me a photo of the delivery note and I type it into Excel at night. We also lose money on fuel because nobody plans the route, riders just go in whatever order they feel like.`,
  },

  accounting: {
    email: 'hello@example.com',
    businessName: 'Ledger & Co',
    businessType: 'small accounting and tax practice',
    country: 'Nigeria',
    teamSize: 'TWO_TO_FIVE',
    monthlyRevenueRange: 'FIVE_TO_20K',
    adminHoursPerWeek: 18,
    currentTools: ['QuickBooks', 'Gmail', 'WhatsApp', 'Excel'],
    painPoints: `Chasing clients for documents is killing us. Every filing season I send the same reminder emails five or six times per client and half still send a blurry photo of a receipt at the last minute. Invoicing is manual - I write each one in Excel, email a PDF, then have to remember who hasn't paid. Right now about 400k naira is sitting unpaid and I only noticed because I sat down and counted. And every new client onboarding is me writing the same welcome email and the same document checklist from scratch.`,
  },

  // Deliberately thin, to exercise the adaptive follow-up path. Triage should
  // want a question here; if it does not, the triage prompt is too permissive.
  vague: {
    email: 'test@example.com',
    businessType: 'retail shop',
    country: 'Nigeria',
    currentTools: [],
    painPoints: 'Too much paperwork and I am always busy but not making enough money.',
  },
};

export const fixtureNames = Object.keys(fixtures);
