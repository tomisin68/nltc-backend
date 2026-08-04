const crypto = require('crypto');

// Temporary passwords for freshly created admin accounts.
//
// These were built from Math.random().toString(36) — roughly 12 characters, but
// only ~2^52 of unguessable state in total, and drawn from a PRNG whose internal
// state is recoverable from a few observed outputs. For a credential that opens
// an *admin* console, is emailed in plaintext, and lives until someone
// remembers to change it, that is not enough. crypto.randomBytes is.
//
// The suffix keeps the result inside Firebase Auth's complexity expectations
// regardless of what base64url happens to produce.
function generateTempPassword() {
  const body = crypto.randomBytes(18)          // 144 bits
    .toString('base64url')
    .slice(0, 20);
  return `${body}!7`;
}

module.exports = { generateTempPassword };
