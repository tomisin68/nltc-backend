const express        = require('express');
const admin          = require('firebase-admin');
const { requireAdmin }         = require('../middleware/auth');
const asyncHandler             = require('../utils/asyncHandler');
const logger                   = require('../utils/logger');
const { getDb }                = require('../../config/firebase');
const { sendPushToTokens, broadcastInAppNotification } = require('../services/notificationService');

const router = express.Router();

// All live-control routes require admin
router.use(requireAdmin);

// ─── POST /api/live/start ────────────────────────────────────────────────────
// Creates a live session document and pushes notifications to all students.
// Replaces the onLiveSessionCreate Cloud Function.
router.post('/start', asyncHandler(async (req, res) => {
  const { title, subject, examType, channelName, hostName, description } = req.body;
  if (!title || !channelName) {
    return res.status(400).json({ error: 'title and channelName are required' });
  }

  const db = getDb();

  // Create the liveSessions document
  const sessionRef = await db.collection('liveSessions').add({
    title,
    subject:      subject      || '',
    examType:     examType     || '',
    channel:      channelName,
    hostId:       req.user.uid,
    hostName:     hostName     || req.userData?.firstName || 'Admin',
    description:  description  || '',
    status:       'live',
    viewerCount:  0,
    startedAt:    admin.firestore.FieldValue.serverTimestamp(),
    muteAll:      false,
    mutedUsers:   {},
    kickedUsers:  {},
    pinnedMessage: '',
    raisedHands:  {},
  });

  const sessionId  = sessionRef.id;
  const notifTitle = `📡 Live Now: ${title}`;
  const notifBody  = `${subject || ''} class just started! Join now.`.trim();
  const notifData  = { type: 'live_class_start', sessionId, url: '/student.html' };

  // Push to all students (fire-and-forget)
  db.collection('users').where('role', '==', 'student').get()
    .then(async snap => {
      const allTokens = [];
      snap.forEach(d => allTokens.push(...(d.data().fcmTokens || [])));
      if (allTokens.length) {
        await sendPushToTokens(allTokens, { title: notifTitle, body: notifBody, data: notifData });
      }
    })
    .catch(e => logger.error('live/start push failed', { err: e.message }));

  // In-app notifications to all students (fire-and-forget)
  broadcastInAppNotification({
    filter:    'all',
    title:     notifTitle,
    body:      notifBody,
    type:      'live_class_start',
    iconEmoji: '📡',
    data:      notifData,
  }).catch(e => logger.error('live/start in-app notif failed', { err: e.message }));

  logger.info('Live session started', { sessionId, title, by: req.user.uid });
  res.status(201).json({ success: true, sessionId });
}));

// ─── POST /api/live/mute-user ────────────────────────────────────────────────
router.post('/mute-user', asyncHandler(async (req, res) => {
  const { sessionId, targetUid } = req.body;
  if (!sessionId || !targetUid) {
    return res.status(400).json({ error: 'sessionId and targetUid are required' });
  }

  await getDb().collection('liveSessions').doc(sessionId).update({
    [`mutedUsers.${targetUid}`]:    true,
    [`muteCommand_${targetUid}`]:   admin.firestore.FieldValue.serverTimestamp(),
  });

  logger.info('Live: user muted', { sessionId, targetUid, by: req.user.uid });
  res.json({ success: true, message: 'User muted successfully' });
}));

// ─── POST /api/live/remove-user ──────────────────────────────────────────────
router.post('/remove-user', asyncHandler(async (req, res) => {
  const { sessionId, targetUid } = req.body;
  if (!sessionId || !targetUid) {
    return res.status(400).json({ error: 'sessionId and targetUid are required' });
  }

  await getDb().collection('liveSessions').doc(sessionId).update({
    [`kickedUsers.${targetUid}`]: true,
  });

  logger.info('Live: user removed', { sessionId, targetUid, by: req.user.uid });
  res.json({ success: true });
}));

// ─── POST /api/live/mute-all ─────────────────────────────────────────────────
router.post('/mute-all', asyncHandler(async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = getDb();
  await db.collection('liveSessions').doc(sessionId).update({
    muteAll:   true,
    muteAllAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Auto-reset after 3 s so the flag can be retriggered
  setTimeout(() => {
    db.collection('liveSessions').doc(sessionId)
      .update({ muteAll: false })
      .catch(e => logger.warn('muteAll reset failed', { sessionId, err: e.message }));
  }, 3000);

  logger.info('Live: mute-all triggered', { sessionId, by: req.user.uid });
  res.json({ success: true, message: 'All users muted' });
}));

// ─── POST /api/live/pin-message ──────────────────────────────────────────────
router.post('/pin-message', asyncHandler(async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }

  await getDb().collection('liveSessions').doc(sessionId).update({
    pinnedMessage: message,
  });

  logger.info('Live: message pinned', { sessionId, by: req.user.uid });
  res.json({ success: true });
}));

// ─── POST /api/live/end-session ──────────────────────────────────────────────
router.post('/end-session', asyncHandler(async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db   = getDb();
  const snap = await db.collection('liveSessions').doc(sessionId).get();
  if (!snap.exists) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // 1. Mark session as ended
  await db.collection('liveSessions').doc(sessionId).update({
    status:  'ended',
    endedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const session = snap.data();
  const title   = `Class ended: ${session.title || 'Live Session'}`;
  const body    = 'The live session has ended. Thank you for joining!';
  const notifData = { type: 'session_ended', sessionId, url: '/student.html' };

  // 2. Push notification to all students (fire-and-forget)
  db.collection('users').where('role', '==', 'student').get().then(async studSnap => {
    const allTokens = [];
    studSnap.forEach(d => allTokens.push(...(d.data().fcmTokens || [])));
    if (allTokens.length) {
      await sendPushToTokens(allTokens, { title, body, data: notifData });
    }
  }).catch(e => logger.error('end-session push failed', { err: e.message }));

  // 3. In-app notification to all students
  broadcastInAppNotification({
    filter:    'all',
    title,
    body,
    type:      'session_ended',
    iconEmoji: '📡',
    data:      notifData,
  }).catch(e => logger.error('end-session in-app notif failed', { err: e.message }));

  logger.info('Live: session ended', { sessionId, by: req.user.uid });
  res.json({ success: true });
}));

module.exports = router;
