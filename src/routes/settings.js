const express      = require('express');
const admin        = require('firebase-admin');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const logger       = require('../utils/logger');
const { getDb }    = require('../../config/firebase');

const router = express.Router();

const DEFAULTS = {
  proMonthly:        2000,
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
  const { proMonthly, lessonFeeDefault } = req.body;

  const updates = {};
  if (proMonthly       != null) updates.proMonthly       = Number(proMonthly);
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

// ─── POST /api/settings/app/download (public) ────────────────────────────────
// Counts an APK download.
//
// Public and unauthenticated because that is who downloads the app: a visitor
// on the homepage who has not signed up yet, which is precisely the number
// worth knowing. It runs server-side rather than as a client Firestore write
// because `settings/app` is public-read and admin-write by rule, and opening
// it up to client increments would let anyone write anything to it.
//
// Fire-and-forget from the page: the download link is never held up waiting
// for this, so a failure here costs a tally, not an install.
router.post('/app/download', asyncHandler(async (req, res) => {
  // Answer first. The caller has an .apk to start and no interest in the
  // outcome, and a slow Firestore write must not sit in front of it.
  res.json({ success: true });

  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  try {
    await getDb().collection('settings').doc('app').set({
      downloadCount:     admin.firestore.FieldValue.increment(1),
      // A per-day map on the same document: the totals are small, and this
      // avoids a collection whose only purpose is to be summed on every read.
      downloadsByDay:    { [day]: admin.firestore.FieldValue.increment(1) },
      lastDownloadAt:    admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    logger.warn?.('APK download count failed', { message: err?.message });
  }
}));

module.exports = router;
