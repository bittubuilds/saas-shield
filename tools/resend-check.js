#!/usr/bin/env node
'use strict';
// Validates the Resend configuration that src/email.js uses in production and,
// when a recipient is given, sends exactly one real email through the same code
// path the app uses. Run: node tools/resend-check.js you@example.com
//
// The key is read from the environment (RESEND_API_KEY) and never printed.

const config = require('../src/config');
const email = require('../src/email');

async function main() {
  const to = process.argv[2] || '';
  const info = email.describeConfig();
  console.log('provider      :', info.provider || '(none)');
  console.log('from          :', info.from);
  console.log('configured    :', info.configured);
  if (info.missing && info.missing.length) console.log('missing config:', info.missing.join(', '));
  if (info.detail) console.log('detail        :', info.detail);

  if (!info.configured) {
    console.error('\nNot configured, so nothing was sent. Set EMAIL_PROVIDER=resend and RESEND_API_KEY.');
    process.exit(2);
  }
  if (!to) {
    console.log('\nConfig looks usable. Pass a recipient address to send one test email:\n  node tools/resend-check.js you@example.com');
    return;
  }
  if (to !== 'me' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    console.error('That does not look like an email address.');
    process.exit(2);
  }

  const recipient = to === 'me' ? config.email.from.replace(/^.*</, '').replace(/>.*$/, '') : to;
  const res = await email.sendMail({
    to: recipient,
    subject: 'SaaS Shield email check',
    text: 'This is a deliverability check from SaaS Shield. If you can read this, your Resend configuration works.'
  });
  console.log('\nsend result   :', JSON.stringify(res));
  if (res && res.ok === false) process.exit(1);
}

main().catch((e) => { console.error('check failed:', e.message); process.exit(1); });
