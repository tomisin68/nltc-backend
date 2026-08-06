// Kill switch for student-facing (Resend-based) email sending — welcome email,
// weekly progress report, inactivity nudge. Defaults OFF: these are suspended
// for now. Set EMAILS_ENABLED=true in the environment to re-enable.
const EMAILS_ENABLED = process.env.EMAILS_ENABLED === 'true';

// Separate switch for admin/staff-facing emails (admin credential emails, center
// manager onboarding, 7-day inactivity alerts to admins/center managers).
// Defaults ON — set ADMIN_EMAILS_ENABLED=false to suspend these too.
const ADMIN_EMAILS_ENABLED = process.env.ADMIN_EMAILS_ENABLED !== 'false';

// Payment mail — the admin's "new receipt" alert and the student's
// confirmed/rejected notice.
//
// Deliberately its own switch rather than riding EMAILS_ENABLED. That one is
// off because welcome notes, weekly reports and inactivity nudges are things
// NLTC sends; these are things a student is owed. Somebody who has just moved
// money and is waiting to be let in expects a confirmation, and an admin who
// does not know a receipt is waiting leaves them locked out — so this defaults
// ON, and suspending marketing mail does not suspend it.
// Set PAYMENT_EMAILS_ENABLED=false to turn it off.
const PAYMENT_EMAILS_ENABLED = process.env.PAYMENT_EMAILS_ENABLED !== 'false';

module.exports = { EMAILS_ENABLED, ADMIN_EMAILS_ENABLED, PAYMENT_EMAILS_ENABLED };
