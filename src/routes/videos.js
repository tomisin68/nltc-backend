const express        = require('express');
const admin          = require('firebase-admin');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const asyncHandler   = require('../utils/asyncHandler');
const logger         = require('../utils/logger');
const { getDb }      = require('../../config/firebase');
const { broadcastInAppNotification } = require('../services/notificationService');

const router = express.Router();

// ─── POST /api/videos/create ─────────────────────────────────────────────────
// Admin uploads a new lesson. Writes to Firestore and notifies all students.
// Replaces the onNewVideo Cloud Function.
router.post('/create', requireAdmin, asyncHandler(async (req, res) => {
  const {
    title,
    subject,
    teacher,
    videoUrl,
    thumbnailUrl,
    description,
    examType,
    duration,    // seconds
  } = req.body;

  if (!title || !videoUrl) {
    return res.status(400).json({ error: 'title and videoUrl are required' });
  }

  const db = getDb();

  // Write to videos collection
  const videoRef = await db.collection('videos').add({
    title,
    subject:      subject      || '',
    teacher:      teacher      || 'NLTC',
    videoUrl,
    thumbnailUrl: thumbnailUrl || null,
    description:  description  || '',
    examType:     examType     || '',
    duration:     duration     || null,
    createdBy:    req.user.uid,
    createdAt:    admin.firestore.FieldValue.serverTimestamp(),
  });

  // In-app notification to all students (fire-and-forget)
  broadcastInAppNotification({
    filter:    'all',
    title:     `New Lesson: ${title}`,
    body:      `${subject || ''} lesson by ${teacher || 'NLTC'} is now available.`.trim(),
    type:      'new_lesson',
    iconEmoji: '🎬',
    data:      { videoId: videoRef.id, url: '/student.html#lessons' },
  }).catch(e => logger.error('new video in-app notif failed', { err: e.message }));

  logger.info('Video created', { videoId: videoRef.id, title, by: req.user.uid });
  res.status(201).json({ success: true, videoId: videoRef.id });
}));

// ─── GET /api/videos ─────────────────────────────────────────────────────────
// Returns the video library (for the student lessons tab).
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { subject, examType, limit = 20 } = req.query;
  const db = getDb();

  let q = db.collection('videos').orderBy('createdAt', 'desc');
  // Note: chaining .where() after .orderBy() needs a composite index.
  // Filtering in-memory keeps it index-free.
  const snap = await q.limit(parseInt(limit) * 3).get();

  let videos = snap.docs.map(d => ({
    id:        d.id,
    ...d.data(),
    createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null,
  }));

  if (subject)  videos = videos.filter(v => v.subject  === subject);
  if (examType) videos = videos.filter(v => v.examType === examType);

  res.json({ videos: videos.slice(0, parseInt(limit)), total: videos.length });
}));

module.exports = router;
