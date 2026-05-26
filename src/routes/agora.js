// src/routes/agora.js
const express          = require('express');
const { body }         = require('express-validator');
const { requireAuth }  = require('../middleware/auth');
const { validate }     = require('../middleware/validate');
const { agoraLimiter } = require('../middleware/rateLimiter');
const { generateRtcToken } = require('../services/agoraService');
const asyncHandler     = require('../utils/asyncHandler');
const logger           = require('../utils/logger');
const { getDb }        = require('../../config/firebase');

const router = express.Router();

/**
 * Check if a uid belongs to an admin or teacher.
 *
 * Priority:
 *   1. Custom claims on the decoded token (fastest — no extra DB read)
 *   2. Firestore /users/{uid}.role field (fallback for apps that store
 *      role in Firestore before custom claims are set via Admin SDK)
 *
 * @param {object} decodedToken  Result of admin.auth().verifyIdToken()
 * @returns {Promise<boolean>}
 */
async function isHostAuthorized(decodedToken) {
  // Fast path: custom claims already set
  if (decodedToken.admin === true || decodedToken.teacher === true) {
    return true;
  }

  // Fallback: read Firestore role field
  try {
    const db   = getDb();
    const snap = await db.collection('users').doc(decodedToken.uid).get();
    if (snap.exists) {
      const role = snap.data()?.role || '';
      return role === 'admin' || role === 'teacher';
    }
  } catch (err) {
    logger.warn('Agora host check — Firestore read failed', { uid: decodedToken.uid, err: err.message });
  }

  return false;
}

// POST /api/agora/token
router.post('/token',
  agoraLimiter,
  requireAuth,
  [
    body('channelName')
      .notEmpty().trim()
      .matches(/^[a-zA-Z0-9_-]+$/)
      .withMessage('channelName must be alphanumeric (underscores/hyphens allowed)'),
    body('role')
      .optional()
      .isIn(['audience', 'host'])
      .withMessage('role must be "audience" or "host"'),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { channelName, role = 'audience' } = req.body;

    // Host tokens are restricted to admins / teachers
    if (role === 'host') {
      const authorized = await isHostAuthorized(req.user);
      if (!authorized) {
        logger.warn('Agora host token refused — insufficient role', { uid: req.user.uid });
        return res.status(403).json({
          error: 'Only admins and teachers can request a host token. ' +
                 'Make sure your user document has role:"admin" or role:"teacher" ' +
                 'in Firestore, or ask your Super Admin to set custom claims.',
        });
      }
    }

    const result = generateRtcToken(channelName, req.user.uid, role);
    logger.info('Agora token issued', { uid: req.user.uid, channelName, role });
    res.json({ success: true, ...result });
  }),
);

// POST /api/agora/call-token
// Peer-to-peer call token — any authenticated real user can get a host token
// for channels that begin with "call_" (format: call_<chatId>_<timestamp>).
// The existing /token endpoint is kept restricted to admins/teachers for live classes.
router.post('/call-token',
  agoraLimiter,
  requireAuth,
  [
    body('channelName')
      .notEmpty().trim()
      .matches(/^call_[a-zA-Z0-9_-]+$/)
      .withMessage('channelName must start with "call_" and be alphanumeric'),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { channelName } = req.body;
    const result = generateRtcToken(channelName, req.user.uid, 'host');
    logger.info('Agora call token issued', { uid: req.user.uid, channelName });
    res.json({ success: true, ...result });
  }),
);

module.exports = router;