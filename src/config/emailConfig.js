// Single kill switch for all custom (Resend-based) email sending.
// Defaults OFF so this takes effect immediately without any Render env change.
// Set EMAILS_ENABLED=true in the environment to re-enable.
const EMAILS_ENABLED = process.env.EMAILS_ENABLED === 'true';

module.exports = { EMAILS_ENABLED };
