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

// ─── GET /api/settings/fees (public) ────────────────────────────────────────
// Used by the frontend useFees hook to know current plan prices.
router.get('/fees', asyncHandler(async (req, res) => {
  const snap = await getDb().collection('settings').doc('fees').get();
  res.json(snap.exists ? snap.data() : DEFAULTS);
}));

// ─── POST /api/settings/fees (admin only) ────────────────────────────────────
// Allows admins to update fee amounts without a code deploy.
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

  logger.info('Fee settings updated', { updates, by: req.user.uid });
  res.json({ success: true, fees: updates });
}));

module.exports = router;
