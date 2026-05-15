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

  const db       = getDb();
  const userRef  = db.collection('users').doc(req.user.uid);
  const userSnap = await userRef.get();
  const existingTokens = userSnap.exists ? (userSnap.data().fcmTokens || []) : [];
  const isFirstToken   = existingTokens.length === 0;

  await userRef.update({
    fcmTokens:      admin.firestore.FieldValue.arrayUnion(fcmToken),
    fcmPlatform:    platform || 'web',
    tokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Send the welcome push the first time this user registers a device
  if (isFirstToken) {
    sendPushToTokens([fcmToken], {
      title: 'Welcome to Next Level TC! 🎓',
      body:  'Your journey to exam success starts now. Stay consistent!',
      data:  { type: 'welcome', url: '/student.html' },
    }).catch(e => logger.error('Welcome push failed', { uid: req.user.uid, err: e.message }));
  }

  logger.info('FCM token registered', { uid: req.user.uid, platform, isFirstToken });
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
    const uid      = target.split(':')[1];
    const userSnap = await db.collection('users').doc(uid).get();
    tokens = userSnap.data()?.fcmTokens || [];

    // Write in-app notification for the targeted user
    db.collection('users').doc(uid).collection('notifications').add({
      title,
      body,
      type:      data?.type || 'announcement',
      data:      data || {},
      iconEmoji: '📢',
      read:      false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(e => logger.error('uid-targeted in-app notif failed', { err: e.message }));
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

// ─── POST /api/notifications/blog-published (admin only) ────────────────────
// Called by the frontend when a blog post is published for the first time.
// Sends a push notification + in-app notification to all users.
router.post('/blog-published', requireAdmin, asyncHandler(async (req, res) => {
  const { title, slug, excerpt } = req.body;
  if (!title || !slug) {
    return res.status(400).json({ error: 'title and slug are required' });
  }

  const db       = getDb();
  const body     = excerpt ? excerpt.slice(0, 120) : 'Read the latest article on the NLTC Blog';
  const url      = `/blog/${slug}`;
  const notifData = { type: 'new_blog', url };

  // 1. In-app notification to all users
  broadcastInAppNotification({
    filter:    'all',
    title:     `📖 New Article: ${title}`,
    body,
    type:      'new_blog',
    iconEmoji: '📖',
    data:      notifData,
  }).catch(e => logger.error('blog in-app broadcast failed', { err: e.message }));

  // 2. FCM push to all users
  db.collection('users').get()
    .then(async snap => {
      const tokens = [];
      snap.forEach(d => tokens.push(...(d.data().fcmTokens || [])));
      if (tokens.length) {
        await sendPushToTokens(tokens, {
          title: `📖 New on NLTC Blog`,
          body:  title,
          data:  { ...notifData, url: `https://nltc.com.ng${url}` },
        });
      }
    })
    .catch(e => logger.error('blog push failed', { err: e.message }));

  logger.info('Blog published notification sent', { title, slug, by: req.user.uid });
  res.json({ success: true });
}));

// ─── POST /api/notifications/cm-send (center manager only) ──────────────────
// Called by CM for broadcasts and schedule changes — sends FCM push to center
// students and writes in-app notifications to students + admins.
router.post('/cm-send', requireAuth, asyncHandler(async (req, res) => {
  const db       = getDb();
  const userSnap = await db.collection('users').doc(req.user.uid).get();
  const userData = userSnap.data() || {};

  if (userData.role !== 'center_manager') {
    return res.status(403).json({ error: 'Center manager access required' });
  }

  const { centerId, centerName, title, body, type, data: extraData } = req.body;
  if (!centerId || !title || !body) {
    return res.status(400).json({ error: 'centerId, title, and body are required' });
  }

  if (userData.center !== centerId) {
    return res.status(403).json({ error: 'You can only send notifications for your own center' });
  }

  const [studentsSnap, adminSnap] = await Promise.all([
    db.collection('users').where('center', '==', centerId).where('role', '==', 'student').get(),
    db.collection('users').where('role', 'in', ['admin', 'super_admin']).get(),
  ]);

  const studentTokens = [];
  const studentIds    = [];
  studentsSnap.forEach(d => {
    studentIds.push(d.id);
    studentTokens.push(...(d.data().fcmTokens || []));
  });

  const adminTokens = [];
  const adminIds    = [];
  adminSnap.forEach(d => {
    adminIds.push(d.id);
    adminTokens.push(...(d.data().fcmTokens || []));
  });

  // FCM push to students
  if (studentTokens.length) {
    sendPushToTokens(studentTokens, { title, body, data: extraData || {} })
      .catch(e => logger.error('CM student push failed', { err: e.message }));
  }

  // FCM push to admins
  if (adminTokens.length) {
    sendPushToTokens(adminTokens, {
      title: `[${centerName}] ${title}`,
      body,
      data: { ...(extraData || {}), centerId, centerName },
    }).catch(e => logger.error('CM admin push failed', { err: e.message }));
  }

  // In-app notifications via batch write
  const notifType = type || 'center_announcement';
  const batch     = db.batch();

  studentIds.forEach(uid => {
    const ref = db.collection('users').doc(uid).collection('notifications').doc();
    batch.set(ref, {
      title, body, type: notifType,
      data:      { centerId, centerName, ...(extraData || {}) },
      iconEmoji: '📢', read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  adminIds.forEach(uid => {
    const ref = db.collection('users').doc(uid).collection('notifications').doc();
    batch.set(ref, {
      title:     `[${centerName}] ${title}`,
      body,
      type:      'center_announcement_alert',
      data:      { centerId, centerName, ...(extraData || {}) },
      iconEmoji: '📣', read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  await batch.commit();

  logger.info('CM notification sent', { centerId, by: req.user.uid, students: studentIds.length, admins: adminIds.length });
  res.json({ success: true, students: studentIds.length, admins: adminIds.length });
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
