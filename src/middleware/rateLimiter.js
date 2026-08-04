const rateLimit = require('express-rate-limit');

// General: 500 req / 15 min per IP.
// Generous enough for shared school/mobile networks (multiple students same IP).
// Override via env vars on Render without a code deploy.
const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10);
const MAX       = parseInt(process.env.RATE_LIMIT_MAX       || '500',    10);

// Payment init: 20 attempts / 15 min per IP (was 10 — too low for retry flows).
const AUTH_MAX  = parseInt(process.env.AUTH_RATE_LIMIT_MAX  || '20',     10);

const generalLimiter = rateLimit({
  windowMs: WINDOW_MS, max: MAX, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: WINDOW_MS, max: AUTH_MAX, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait.' },
});

const webhookLimiter = rateLimit({
  windowMs: 60000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Webhook rate limit exceeded.' },
});

const agoraLimiter = rateLimit({
  windowMs: 60000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many token requests.' },
});

// Email verification (send / resend / verify OTP).
//
// Looser than authLimiter on purpose: a physical centre signs a whole class up
// from one NAT'd IP, and at 20/15min the tail of that class would be locked out
// of verifying at all. Brute force is held off per-account instead — five wrong
// codes burns the OTP — so this limit only has to bound mail volume and blind
// scanning, which 60/15min does comfortably.
const OTP_MAX = parseInt(process.env.OTP_RATE_LIMIT_MAX || '60', 10);

const otpLimiter = rateLimit({
  windowMs: WINDOW_MS, max: OTP_MAX, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many verification requests. Please wait a few minutes.' },
});

module.exports = { generalLimiter, authLimiter, webhookLimiter, agoraLimiter, otpLimiter };