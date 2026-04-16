const express        = require('express');
const admin          = require('firebase-admin');
const { requireAdmin }  = require('../middleware/auth');
const asyncHandler      = require('../utils/asyncHandler');
const logger            = require('../utils/logger');
const { getDb }         = require('../../config/firebase');
const {
  broadcastInAppNotification,
  sendPushToTokens,
} = require('../services/notificationService');

const router = express.Router();

// Map the admin dashboard's sentTo labels to plan filter values
function toFilter(sentTo) {
  if (sentTo === 'Pro Users Only')   return 'pro';
  if (sentTo === 'Free Users Only')  return 'free';
  if (sentTo === 'Elite Users Only') return 'elite';
  return 'all';
}

// ─── POST /api/broadcasts/create ─────────────────────────────────────────────
// Admin creates an announcement. Writes to Firestore AND sends push + in-app
// notifications to the target audience.
// Replaces the onNewBroadcast Cloud Function.
router.post('/create', requireAdmin, asyncHandler(async (req, res) => {
  const { title, message, sentTo = 'All Users', imageUrl } = req.body;

  if (!title || !message) {
    return res.status(400).json({ error: 'title and message are required' });
  }

  const db     = getDb();
  const filter = toFilter(sentTo);

  // 1. Write broadcast document to Firestore
  const bcRef = await db.collection('broadcasts').add({
    title,
    message,
    sentTo,
    imageUrl:  imageUrl || null,
    createdBy: req.user.uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const notifData = {
    type:        'announcement',
    broadcastId: bcRef.id,
    url:         '/student.html#announcements',
  };

  // 2. In-app notification to target audience
  broadcastInAppNotification({
    filter,
    title,
    body:      message,
    type:      'announcement',
    iconEmoji: '📢',
    data:      notifData,
  }).catch(e => logger.error('broadcast in-app notif failed', { err: e.message }));

  // 3. FCM push to target audience (fire-and-forget)
  let q = db.collection('users');
  if (filter === 'pro')   q = q.where('plan', '==', 'pro');
  if (filter === 'free')  q = q.where('plan', '==', 'free');
  if (filter === 'elite') q = q.where('plan', '==', 'elite');

  q.get()
    .then(async snap => {
      const allTokens = [];
      snap.forEach(d => allTokens.push(...(d.data().fcmTokens || [])));
      if (allTokens.length) {
        await sendPushToTokens(allTokens, {
          title,
          body:     message,
          imageUrl: imageUrl || undefined,
          data:     notifData,
        });
      }
    })
    .catch(e => logger.error('broadcast push failed', { err: e.message }));

  logger.info('Broadcast created', { broadcastId: bcRef.id, sentTo, by: req.user.uid });
  res.status(201).json({ success: true, broadcastId: bcRef.id });
}));

// ─── GET /api/broadcasts ─────────────────────────────────────────────────────
// Returns recent broadcasts (for the student announcements tab).
router.get('/', asyncHandler(async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || '20'), 50);
  const snap   = await getDb()
    .collection('broadcasts')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  const broadcasts = snap.docs.map(d => ({
    id:        d.id,
    ...d.data(),
    createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null,
  }));

  res.json({ broadcasts, total: broadcasts.length });
}));

module.exports = router;
