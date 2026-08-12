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

// ─── Chat notification throttle ──────────────────────────────────────────────
// Prevents push spam when messages arrive in rapid succession.
// Key: `${recipientUid}:${chatId}`, value: timestamp of last push sent.
// One notification per recipient per chat per THROTTLE_MS window.
const chatNotifThrottle = new Map();
const THROTTLE_MS = 30_000; // 30 seconds

function shouldSendPush(uid, chatId) {
  const key  = `${uid}:${chatId}`;
  const last = chatNotifThrottle.get(key) || 0;
  if (Date.now() - last < THROTTLE_MS) return false;
  chatNotifThrottle.set(key, Date.now());
  return true;
}

// Prune stale throttle entries every 5 minutes to prevent memory leak
setInterval(() => {
  const cutoff = Date.now() - THROTTLE_MS;
  for (const [k, v] of chatNotifThrottle.entries()) {
    if (v < cutoff) chatNotifThrottle.delete(k);
  }
}, 5 * 60_000).unref();

// ─── POST /api/notifications/chat-message ────────────────────────────────────
// Called client-side (fire-and-forget) after a message is successfully written
// to Firestore. Sends FCM push + in-app notification to all members except the
// sender, skipping anyone within the throttle window.
//
// Body: { chatId, messageText, chatType ('dm'|'group'), chatName, senderName }
router.post('/chat-message', requireAuth, asyncHandler(async (req, res) => {
  const { chatId, messageText, chatType, chatName, senderName } = req.body;

  if (!chatId || !messageText) {
    return res.status(400).json({ error: 'chatId and messageText are required' });
  }

  const db       = getDb();
  const chatSnap = await db.collection('chats').doc(chatId).get();

  if (!chatSnap.exists) {
    return res.status(404).json({ error: 'Chat not found' });
  }

  const chat    = chatSnap.data();
  const members = chat.members || [];

  // Verify the sender is actually a member (security guard)
  if (!members.includes(req.user.uid)) {
    return res.status(403).json({ error: 'Not a member of this chat' });
  }

  const recipients = members.filter(uid => uid !== req.user.uid);
  if (!recipients.length) {
    return res.json({ success: true, sent: 0, skipped: 0 });
  }

  // Fetch all recipients in one batched read
  const recipientDocs = await Promise.all(
    recipients.map(uid => db.collection('users').doc(uid).get()),
  );

  const preview = messageText.length > 120
    ? messageText.slice(0, 117) + '…'
    : messageText;

  const senderFirst = (senderName || 'Someone').split(' ')[0];

  // Build notification content based on chat type
  const isGroup  = chatType === 'group';
  const pushTitle = isGroup
    ? `💬 ${chatName || 'Group Chat'}`
    : `💬 ${senderName || 'New message'}`;
  const pushBody  = isGroup
    ? `${senderFirst}: ${preview}`
    : preview;

  const deepLink  = `https://nltc.com.ng/dashboard?view=chat&chatId=${chatId}`;

  const fcmTokens   = [];
  const inAppWrites = [];
  let   skipped     = 0;

  for (const snap of recipientDocs) {
    if (!snap.exists) continue;
    const uid      = snap.id;
    const userData = snap.data();

    // In-app notification for ALL recipients (always, regardless of throttle/presence)
    inAppWrites.push({
      ref:  snap.ref.collection('notifications').doc(),
      data: {
        title:     isGroup
          ? `New message in ${chatName || 'Group'}`
          : `New message from ${senderName || 'Someone'}`,
        body:      isGroup ? `${senderFirst}: ${preview}` : preview,
        type:      'chat_message',
        iconEmoji: '💬',
        data:      { chatId, chatType, url: `/dashboard?view=chat&chatId=${chatId}` },
        read:      false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    });

    // FCM push — skip if throttled (already notified recently for this chat)
    if (!shouldSendPush(uid, chatId)) {
      skipped++;
      continue;
    }

    // Skip push if the user is currently online (they'll see the unread badge)
    // "Online" = online flag is true AND last seen within 3 minutes
    const isOnline = userData.online === true &&
      userData.lastSeen?.toMillis &&
      Date.now() - userData.lastSeen.toMillis() < 3 * 60_000;

    if (isOnline) {
      skipped++;
      continue;
    }

    const tokens = userData.fcmTokens || [];
    fcmTokens.push(...tokens.map(token => ({ uid, token })));
  }

  // Write all in-app notifications in a single batch
  if (inAppWrites.length) {
    const CHUNK = 490;
    for (let i = 0; i < inAppWrites.length; i += CHUNK) {
      const batch = db.batch();
      inAppWrites.slice(i, i + CHUNK).forEach(({ ref, data }) => batch.set(ref, data));
      await batch.commit();
    }
  }

  // Send FCM push (fire-and-forget — don't block the response)
  let pushSent = 0;
  if (fcmTokens.length) {
    const flatTokens = fcmTokens.map(t => t.token);
    sendPushToTokens(flatTokens, {
      title: pushTitle,
      body:  pushBody,
      data:  {
        type:    'chat_message',
        chatId,
        chatType: chatType || 'dm',
        chatName: chatName || '',
        url:      deepLink,
      },
    })
      .then(r => {
        pushSent = r.sent;
        logger.info('Chat push sent', {
          chatId, by: req.user.uid, sent: r.sent, total: r.total, skipped,
        });
      })
      .catch(e => logger.error('Chat push failed', { chatId, err: e.message }));
  }

  res.json({ success: true, sent: fcmTokens.length, inApp: inAppWrites.length, skipped });
}));

// ─── POST /api/notifications/group-invite ────────────────────────────────────
// Called client-side (fire-and-forget) after uids are written into a group's
// `pendingMembers`. Tells them somebody has asked them to join.
//
// Nobody is put into a group any more — they are invited, and the invitation
// waits in a tray until answered. That makes this notification the only way an
// invited student finds out at all, which is also why it is checked as hard as
// it is: the caller must be an admin OF THAT GROUP, and every recipient must
// actually be sitting in its `pendingMembers`. Without both, an endpoint that
// pushes named text to a list of uids is a spam cannon.
//
// Body: { chatId, uids: [uid], groupName, inviterName }
router.post('/group-invite', requireAuth, asyncHandler(async (req, res) => {
  const { chatId, uids, groupName, inviterName } = req.body;

  if (!chatId || !Array.isArray(uids) || !uids.length) {
    return res.status(400).json({ error: 'chatId and uids are required' });
  }

  const db       = getDb();
  const chatSnap = await db.collection('chats').doc(chatId).get();

  if (!chatSnap.exists) {
    return res.status(404).json({ error: 'Chat not found' });
  }

  const chat    = chatSnap.data();
  const admins  = [chat.groupAdmin, ...(chat.groupAdmins || [])].filter(Boolean);
  const pending = chat.pendingMembers || [];

  if (chat.type !== 'group' || !admins.includes(req.user.uid)) {
    return res.status(403).json({ error: 'Not an admin of this group' });
  }

  // Only people the group document itself says are waiting on an invitation.
  const recipients = uids
    .filter(uid => typeof uid === 'string' && pending.includes(uid))
    .slice(0, 100);

  if (!recipients.length) {
    return res.json({ success: true, sent: 0 });
  }

  const name    = (groupName   || chat.name || 'a study group').slice(0, 80);
  const inviter = (inviterName || 'Someone').slice(0, 80);
  const url     = `https://nltc.com.ng/dashboard?view=chat&invite=${chatId}`;

  const recipientDocs = await Promise.all(
    recipients.map(uid => db.collection('users').doc(uid).get()),
  );

  const fcmTokens   = [];
  const inAppWrites = [];

  for (const snap of recipientDocs) {
    if (!snap.exists) continue;

    inAppWrites.push({
      ref:  snap.ref.collection('notifications').doc(),
      data: {
        title:     `${inviter} invited you to ${name}`,
        body:      'You are not in the group until you accept the invitation.',
        type:      'group_invite',
        iconEmoji: '👥',
        data:      { chatId, url },
        read:      false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    });

    // No throttle and no online-skip, unlike a chat message: an invitation is
    // one event and not a stream of them, and it needs an answer.
    fcmTokens.push(...(snap.data().fcmTokens || []));
  }

  if (inAppWrites.length) {
    const batch = db.batch();
    inAppWrites.forEach(({ ref, data }) => batch.set(ref, data));
    await batch.commit();
  }

  if (fcmTokens.length) {
    sendPushToTokens(fcmTokens, {
      title: `👥 ${name}`,
      body:  `${inviter} invited you to join`,
      data:  { type: 'group_invite', chatId, url },
    })
      .then(r => logger.info('Group invite push sent', {
        chatId, by: req.user.uid, sent: r.sent, total: r.total,
      }))
      .catch(e => logger.error('Group invite push failed', {
        chatId, err: e.message,
      }));
  }

  res.json({ success: true, sent: fcmTokens.length, inApp: inAppWrites.length });
}));

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
    // 'all' → no extra filter

    const snap = await q.get();
    snap.forEach(d => tokens.push(...(d.data().fcmTokens || [])));
  }

  const result = await sendPushToTokens(tokens, { title, body, data, imageUrl });

  // Also write in-app notification for segment sends
  if (!target?.startsWith('uid:')) {
    const filter = ['pro','free'].includes(target) ? target : 'all';
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
