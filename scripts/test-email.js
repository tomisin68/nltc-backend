// Quick smoke-test for the email service.
// Run from the nltc-backend directory:
//   node scripts/test-email.js [recipient@example.com]
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { sendWelcomeEmail, verifyTransporter } = require('../src/services/emailService');

(async () => {
  const to = process.argv[2] || process.env.EMAIL_USER;
  if (!to) {
    console.error('Usage: node scripts/test-email.js <recipient-email>');
    process.exit(1);
  }

  console.log('RESEND_API_KEY  :', process.env.RESEND_API_KEY ? process.env.RESEND_API_KEY.slice(0, 8) + '…' : '(not set)');
  console.log('RESEND_FROM     :', process.env.RESEND_FROM_EMAIL || '(not set)');
  console.log('Recipient       :', to);
  console.log('');

  console.log('Step 1 — Verifying Resend config…');
  const ok = await verifyTransporter();
  if (!ok) {
    console.error('Resend config invalid. Check RESEND_API_KEY.');
    process.exit(1);
  }
  console.log('Resend config OK');

  console.log('Step 2 — Sending welcome email…');
  await sendWelcomeEmail({ email: to, firstName: 'Samuel' });
  console.log('Done — check the inbox at:', to);
})();
