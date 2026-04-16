const express        = require('express');
const admin          = require('firebase-admin');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const asyncHandler   = require('../utils/asyncHandler');
const logger         = require('../utils/logger');
const { getDb }      = require('../../config/firebase');
const {
  sendPushToTokens,
  broadcastInAppNotification,
} = require('../services/notificationService');

const router = express.Router();

// ─── POST /api/notifications/register-token ──────────────────────────────────
router.post('/register-token', requireAuth, asyncHandler(async (req, res) => {
  const { fcmToken, platform } = req.body;
  if (!fcmToken) {
    return res.status(400).json({ error: 'fcmToken is required' });
  }

  await getDb().collection('users').doc(req.user.uid).update({
    fcmTokens:      admin.firestore.FieldValue.arrayUnion(fcmToken),
    fcmPlatform:    platform || 'web',
    tokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  logger.info('FCM token registered', { uid: req.user.uid, platform });
  res.json({ success: true });
}));

// ─── POST /api/notifications/send (admin only) ───────────────────────────────
router.post('/send', requireAdmin, asyncHandler(async (req, res) => {
  const { target, title, body, data, imageUrl } = req.body;
  if (!target || !title || !body) {
    return res.status(400).json({ error: 'target, title, and body are required' });
  }

  const db     = getDb();
  let   tokens = [];

  if (target?.startsWith('uid:')) {
    // Single user
    const uid  = target.split(':')[1];
    const snap = await db.collection('users').doc(uid).get();
    tokens = snap.data()?.fcmTokens || [];
  } else {
    // Segment query
    let q = db.collection('users');
    if (target === 'pro')   q = q.where('plan', '==', 'pro');
    if (target === 'free')  q = q.where('plan', '==', 'free');
    if (target === 'elite') q = q.where('plan', '==', 'elite');
    // 'all' → no extra filter

    const snap = await q.get();
    snap.forEach(d => tokens.push(...(d.data().fcmTokens || [])));
  }

  const result = await sendPushToTokens(tokens, { title, body, data, imageUrl });

  // Also write in-app notification for segment sends
  if (!target?.startsWith('uid:')) {
    const filter = ['pro','free','elite'].includes(target) ? target : 'all';
    broadcastInAppNotification({
      filter,
      title,
      body,
      type:      data?.type || 'announcement',
      iconEmoji: '📢',
      data:      data || {},
    }).catch(e => logger.error('in-app broadcast failed', { err: e.message }));
  }

  logger.info('Admin push sent', { target, sent: result.sent, total: result.total, by: req.user.uid });
  res.json({ success: true, ...result });
}));

// ─── GET /api/notifications/me ───────────────────────────────────────────────
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const db   = getDb();
  const snap = await db
    .collection('users').doc(req.user.uid)
    .collection('notifications')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();

  const notifications = snap.docs.map(d => ({
    id:        d.id,
    ...d.data(),
    createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null,
  }));

  const unreadCount = notifications.filter(n => !n.read).length;
  res.json({ notifications, unreadCount });
}));

// ─── POST /api/notifications/mark-read ──────────────────────────────────────
router.post('/mark-read', requireAuth, asyncHandler(async (req, res) => {
  const { notifIds, all } = req.body;
  const db      = getDb();
  const userRef = db.collection('users').doc(req.user.uid);

  if (all) {
    const snap = await userRef
      .collection('notifications')
      .where('read', '==', false)
      .get();
    const batch = db.batch();
    snap.forEach(d => batch.update(d.ref, { read: true }));
    await batch.commit();
    return res.json({ success: true, updated: snap.size });
  }

  if (!notifIds || !Array.isArray(notifIds) || !notifIds.length) {
    return res.status(400).json({ error: 'Provide notifIds array or all:true' });
  }

  const batch = db.batch();
  notifIds.forEach(id =>
    batch.update(userRef.collection('notifications').doc(id), { read: true })
  );
  await batch.commit();

  res.json({ success: true, updated: notifIds.length });
}));

module.exports = router;
