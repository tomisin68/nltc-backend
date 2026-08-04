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

/**
 * Is this user entitled to join this 1:1 call channel?
 *
 * Membership of the chat is the whole boundary. A channel name is not a secret
 * — it is derived from the chat id, sits in a Firestore document, and travels
 * through both clients — so "knows the channel name" cannot be the check.
 *
 * Two ways to establish it, because the web overlay and the mobile app send
 * different things:
 *   • an explicit chatId (preferred) — verified against that chat's members
 *   • no chatId — find a chat the caller belongs to whose live activeCall is on
 *     this exact channel. Slower, but it means older app builds keep working
 *     without being handed a blanket pass.
 */
async function isCallParticipant(uid, channelName, chatId) {
  const db = getDb();

  if (chatId) {
    const snap = await db.collection('chats').doc(String(chatId)).get();
    if (!snap.exists) return false;
    if (!(snap.data().members || []).includes(uid)) return false;

    // Belonging to the chat is not licence to name any channel — the request has
    // to be for this chat's own call. Either it is the call currently ringing,
    // or it carries this chat's id (the caller requests its token a beat before
    // activeCall is written).
    return snap.data().activeCall?.channel === channelName
        || String(channelName).startsWith(`call_${chatId}`);
  }

  const mine = await db.collection('chats').where('members', 'array-contains', uid).get();
  return mine.docs.some(d => d.data().activeCall?.channel === channelName);
}

// POST /api/agora/call-token
// Peer-to-peer call token for a chat the caller is actually in.
//
// This used to hand a host token to any authenticated user for any channel
// matching /^call_.../ — no membership check at all. Channel names are derived
// from chat ids and are visible to both participants, so anyone who learned or
// guessed one could join a private student call and listen in, or publish audio
// and video into it. The existing /token endpoint stays restricted to
// admins/teachers for live classes.
router.post('/call-token',
  agoraLimiter,
  requireAuth,
  [
    body('channelName')
      .notEmpty().trim()
      .matches(/^call_[a-zA-Z0-9_-]+$/)
      .withMessage('channelName must start with "call_" and be alphanumeric'),
    body('chatId').optional().isString().trim().notEmpty(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { channelName, chatId } = req.body;

    const allowed = await isCallParticipant(req.user.uid, channelName, chatId);
    if (!allowed) {
      logger.warn('Agora call token refused — not a participant', { uid: req.user.uid, channelName, chatId });
      return res.status(403).json({ error: 'You are not a participant in this call' });
    }

    const result = generateRtcToken(channelName, req.user.uid, 'host');
    logger.info('Agora call token issued', { uid: req.user.uid, channelName });
    res.json({ success: true, ...result });
  }),
);

module.exports = router;