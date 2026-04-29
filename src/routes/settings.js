const express      = require('express');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const logger       = require('../utils/logger');
const { getDb }    = require('../../config/firebase');

const router = express.Router();

const DEFAULTS = {
  proMonthly:        5000,
  eliteMonthly:      10000,
  lessonFeeDefault:  5000,
};

// In-memory cache — avoids a Firestore read on every page load.
let feesCache = null;
let feesCachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── GET /api/settings/fees (public) ────────────────────────────────────────
router.get('/fees', asyncHandler(async (req, res) => {
  const now = Date.now();
  if (feesCache && now - feesCachedAt < CACHE_TTL_MS) {
    return res.json(feesCache);
  }
  try {
    const snap = await getDb().collection('settings').doc('fees').get();
    feesCache   = snap.exists ? snap.data() : DEFAULTS;
    feesCachedAt = now;
    res.json(feesCache);
  } catch {
    // Firestore unavailable (quota, network) — return cached or defaults
    res.json(feesCache || DEFAULTS);
  }
}));

// ─── POST /api/settings/fees (admin only) ────────────────────────────────────
router.post('/fees', requireAdmin, asyncHandler(async (req, res) => {
  const { proMonthly, eliteMonthly, lessonFeeDefault } = req.body;

  const updates = {};
  if (proMonthly       != null) updates.proMonthly       = Number(proMonthly);
  if (eliteMonthly     != null) updates.eliteMonthly     = Number(eliteMonthly);
  if (lessonFeeDefault != null) updates.lessonFeeDefault = Number(lessonFeeDefault);

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'Provide at least one fee field to update' });
  }

  for (const [key, val] of Object.entries(updates)) {
    if (!Number.isFinite(val) || val <= 0) {
      return res.status(400).json({ error: `${key} must be a positive number` });
    }
  }

  await getDb().collection('settings').doc('fees').set(updates, { merge: true });

  // Bust the cache so the next GET returns fresh data
  feesCache = null;

  logger.info('Fee settings updated', { updates, by: req.user.uid });
  res.json({ success: true, fees: updates });
}));

module.exports = router;
