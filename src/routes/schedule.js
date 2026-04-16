const express        = require('express');
const admin          = require('firebase-admin');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const asyncHandler   = require('../utils/asyncHandler');
const logger         = require('../utils/logger');
const { getDb }      = require('../../config/firebase');
const {
  broadcastInAppNotification,
  sendPushToTokens,
} = require('../services/notificationService');

const router = express.Router();

// ─── POST /api/schedule/send-reminders ───────────────────────────────────────
// Called every 30 minutes by Render's Cron Job.
// Protected by a shared secret (not Firebase auth) since Render calls it,
// not a logged-in user.
// Replaces the Cloud Scheduler + scheduledClassReminders Cloud Function.
router.post('/send-reminders', asyncHandler(async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db  = getDb();
  const now = Date.now();

  // Fetch classes scheduled within the next 25 hours (wide window to catch both buckets)
  const windowEnd = new Date(now + 25 * 60 * 60 * 1000);
  const snap = await db
    .collection('schedule')
    .where('scheduledAt', '>', new Date(now))
    .where('scheduledAt', '<', windowEnd)
    .get();

  // Collect all student tokens once (reused across reminders)
  const studentsSnap = await db.collection('users').where('role', '==', 'student').get();
  const allTokens    = [];
  studentsSnap.forEach(d => allTokens.push(...(d.data().fcmTokens || [])));

  let sent = 0;

  for (const doc of snap.docs) {
    const cls       = doc.data();
    const classTime = cls.scheduledAt?.toMillis?.() || 0;
    const diff      = classTime - now;                // ms until class

    const is24h = diff >= 23.5 * 3600000 && diff <= 24.5 * 3600000;
    const is1h  = diff >=       3300000  && diff <=       3900000;

    // ── 24-hour reminder ───────────────────────────────────────────
    if (is24h && !cls.reminder24hSent) {
      const title = `⏰ Class Reminder: ${cls.title}`;
      const body  = `"${cls.title}" starts tomorrow. Get ready!`;

      await broadcastInAppNotification({
        filter:    'all',
        title, body,
        type:      'class_reminder',
        iconEmoji: '📅',
        data:      { url: '/student.html#schedule' },
      });

      if (allTokens.length) {
        sendPushToTokens(allTokens, { title, body, data: { type: 'class_reminder', url: '/student.html#schedule' } })
          .catch(e => logger.error('24h reminder push failed', { err: e.message }));
      }

      // Mark so we don't send it again next cron run
      await doc.ref.update({ reminder24hSent: true });
      sent++;
      logger.info('24h reminder sent', { classId: doc.id, title: cls.title });
    }

    // ── 1-hour reminder ────────────────────────────────────────────
    if (is1h && !cls.reminder1hSent) {
      const title = `⏰ Class Reminder: ${cls.title}`;
      const body  = `"${cls.title}" starts in 1 hour. Get ready!`;

      await broadcastInAppNotification({
        filter:    'all',
        title, body,
        type:      'class_reminder',
        iconEmoji: '📅',
        data:      { url: '/student.html#schedule' },
      });

      if (allTokens.length) {
        sendPushToTokens(allTokens, { title, body, data: { type: 'class_reminder', url: '/student.html#schedule' } })
          .catch(e => logger.error('1h reminder push failed', { err: e.message }));
      }

      await doc.ref.update({ reminder1hSent: true });
      sent++;
      logger.info('1h reminder sent', { classId: doc.id, title: cls.title });
    }
  }

  logger.info('Cron: send-reminders complete', { checked: snap.size, sent });
  res.json({ success: true, checked: snap.size, sent });
}));

// ─── POST /api/schedule/create ───────────────────────────────────────────────
// Admin schedules a new class.
router.post('/create', requireAdmin, asyncHandler(async (req, res) => {
  const { title, subject, examType, scheduledAt, description, channelName } = req.body;

  if (!title || !scheduledAt) {
    return res.status(400).json({ error: 'title and scheduledAt are required' });
  }

  const db        = getDb();
  const classDate = new Date(scheduledAt);
  if (isNaN(classDate.getTime())) {
    return res.status(400).json({ error: 'scheduledAt must be a valid ISO date string' });
  }

  const classRef = await db.collection('schedule').add({
    title,
    subject:          subject     || '',
    examType:         examType    || '',
    channelName:      channelName || '',
    description:      description || '',
    scheduledAt:      admin.firestore.Timestamp.fromDate(classDate),
    createdBy:        req.user.uid,
    createdAt:        admin.firestore.FieldValue.serverTimestamp(),
    reminder24hSent:  false,
    reminder1hSent:   false,
  });

  logger.info('Class scheduled', { classId: classRef.id, title, scheduledAt });
  res.status(201).json({ success: true, classId: classRef.id });
}));

// ─── GET /api/schedule ───────────────────────────────────────────────────────
// Returns upcoming scheduled classes (for the student timetable).
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const db    = getDb();
  const limit = Math.min(parseInt(req.query.limit || '20'), 50);

  const snap = await db
    .collection('schedule')
    .where('scheduledAt', '>=', new Date())
    .orderBy('scheduledAt', 'asc')
    .limit(limit)
    .get();

  const classes = snap.docs.map(d => ({
    id:          d.id,
    ...d.data(),
    scheduledAt: d.data().scheduledAt?.toDate?.()?.toISOString() || null,
    createdAt:   d.data().createdAt?.toDate?.()?.toISOString()   || null,
  }));

  res.json({ classes, total: classes.length });
}));

module.exports = router;
