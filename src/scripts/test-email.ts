// Send one real email and report exactly why it failed if it did.
//
// Domain verification is the kind of thing that looks finished in a dashboard
// and still does not deliver, so this proves the actual path: this key, this
// EMAIL_FROM, this recipient.
//
//   npm run email:test -- you@example.com
//
// Two failures worth recognising in the output:
//
//   "domain is not verified"  — EMAIL_FROM uses a domain Resend has not verified
//   "You can only send testing emails to your own email address"
//                             — EMAIL_FROM is the shared resend.dev sender, which
//                               delivers only to the Resend account owner

import '../load-env.js';

const { Resend } = await import('resend');
const { env } = await import('../env.js');

const to = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

if (!to) {
  console.error('Usage: npm run email:test -- you@example.com');
  process.exit(1);
}

if (!env.RESEND_API_KEY) {
  console.error('RESEND_API_KEY is not set.');
  process.exit(1);
}

const usingSharedSender = env.EMAIL_FROM.includes('resend.dev');

console.log(`from : ${env.EMAIL_FROM}`);
console.log(`to   : ${to}`);
if (usingSharedSender) {
  console.log("note : shared resend.dev sender — only the Resend account owner's address will accept this");
}
console.log('');

const resend = new Resend(env.RESEND_API_KEY);

const result = await resend.emails.send({
  from: env.EMAIL_FROM,
  to,
  subject: 'BusinessAutomate — email delivery test',
  text: [
    'If you are reading this, transactional email works.',
    '',
    `Sent from: ${env.EMAIL_FROM}`,
    '',
    'This is the same path the audit-ready, payment-unlocked and follow-up',
    'messages use, so all three will now reach customers.',
  ].join('\n'),
  html: `<p>If you are reading this, transactional email works.</p>
<p>Sent from: <strong>${env.EMAIL_FROM}</strong></p>
<p>This is the same path the audit-ready, payment-unlocked and follow-up messages use, so all three will now reach customers.</p>`,
});

if (result.error) {
  console.error(`FAILED: ${result.error.message}`);
  if (usingSharedSender) {
    console.error(
      '\nMost likely the shared sender. Verify brainycyber.com at resend.com/domains,\n' +
        'then set EMAIL_FROM to an address on it.',
    );
  }
  process.exit(1);
}

console.log(`SENT. Resend id: ${result.data?.id}`);
console.log('Check the inbox, and the spam folder — a newly verified domain often lands there first.');
