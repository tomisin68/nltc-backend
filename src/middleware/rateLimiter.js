const rateLimit = require('express-rate-limit');

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10);
const MAX       = parseInt(process.env.RATE_LIMIT_MAX       || '100',    10);
const AUTH_MAX  = parseInt(process.env.AUTH_RATE_LIMIT_MAX  || '10',     10);

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

module.exports = { generalLimiter, authLimiter, webhookLimiter, agoraLimiter };