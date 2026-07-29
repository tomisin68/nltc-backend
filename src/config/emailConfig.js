// Kill switch for student-facing (Resend-based) email sending — welcome email,
// weekly progress report, inactivity nudge. Defaults OFF: these are suspended
// for now. Set EMAILS_ENABLED=true in the environment to re-enable.
const EMAILS_ENABLED = process.env.EMAILS_ENABLED === 'true';

// Separate switch for admin/staff-facing emails (admin credential emails, center
// manager onboarding, 7-day inactivity alerts to admins/center managers).
// Defaults ON — set ADMIN_EMAILS_ENABLED=false to suspend these too.
const ADMIN_EMAILS_ENABLED = process.env.ADMIN_EMAILS_ENABLED !== 'false';

module.exports = { EMAILS_ENABLED, ADMIN_EMAILS_ENABLED };
