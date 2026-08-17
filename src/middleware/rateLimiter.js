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
// Counted **per account, not per IP**, which matters far more now that
// verification is compulsory: a physical centre puts a whole class behind one
// NAT'd address, and every one of those students must now get through this to
// use the app at all. At 60 requests per IP per 15 minutes — and each student
// costing a send plus at least one verify — a class of forty arriving together
// would have run the bucket dry around the twentieth, and the rest would have
// been held on a screen they could not pass, reading "too many requests" for
// something they had done once.
//
// Keying on the uid also makes the number mean what it should. Nobody
// legitimately needs fifteen verification requests for one account in a quarter
// of an hour, and blind scanning is bounded elsewhere: generalLimiter caps every
// IP at 500/15min before this is reached, and five wrong codes burn the OTP
// itself. All three routes sit behind requireAuth, so the uid is always there.
const OTP_MAX = parseInt(process.env.OTP_RATE_LIMIT_MAX || '15', 10);

const otpLimiter = rateLimit({
  windowMs: WINDOW_MS, max: OTP_MAX, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => (req.user?.uid ? `uid:${req.user.uid}` : `ip:${req.ip}`),
  // The IPv6-normalisation check only applies to keys that are bare addresses;
  // these are prefixed and usually a uid, so it would only ever misfire.
  validate: { ip: false },
  message: { error: 'Too many verification requests. Please wait a few minutes.' },
});

module.exports = { generalLimiter, authLimiter, webhookLimiter, agoraLimiter, otpLimiter };