const express        = require('express');
const admin          = require('firebase-admin');
const { requireAuth }          = require('../middleware/auth');
const asyncHandler             = require('../utils/asyncHandler');
const logger                   = require('../utils/logger');
const { getDb }                = require('../../config/firebase');
const { sendInAppNotification, sendPushToTokens } = require('../services/notificationService');
const { sendWelcomeEmail, verifyTransporter } = require('../services/emailService');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ─── POST /api/users/on-signup ───────────────────────────────────────────────
// Called by the frontend immediately after Firebase createUserWithEmailAndPassword.
// Creates the Firestore user document, sends a welcome notification to the
// student, and alerts all admins of the new signup.
router.post('/on-signup', requireAuth, asyncHandler(async (req, res) => {
  const db  = getDb();
  const uid = req.user.uid;

  const {
    firstName   = '',
    lastName    = '',
    phone       = '',
    state       = '',
    targetExam  = '',
    plan        = 'free',
  } = req.body;

  const email = req.user.email || req.userData?.email || '';
  const name  = `${firstName} ${lastName}`.trim();

  // 1. Create / merge the user document
  await db.collection('users').doc(uid).set(
    {
      uid,
      email,
      firstName,
      lastName,
      phone,
      state,
      targetExam,
      plan,
      role:         'student',
      xp:           0,
      streak:       0,
      cbtCount:     0,
      totalCorrect: 0,
      achievements: [],
      fcmTokens:    [],
      createdAt:    admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // 2. Welcome in-app notification to the new student
  await sendInAppNotification(uid, {
    title:     'Welcome to NLTC! 🎉',
    body:      'Your account is ready. Start learning today.',
    type:      'welcome',
    iconEmoji: '🎓',
    data:      { url: '/student.html' },
  });

  // 3. Welcome FCM push (fire-and-forget — tokens may be registered moments after signup)
  const fcmTokens = req.body.fcmTokens || req.userData?.fcmTokens || [];
  if (fcmTokens.length) {
    sendPushToTokens(fcmTokens, {
      title: 'Welcome to Next Level TC! 🎓',
      body:  'Your journey to exam success starts now.',
      data:  { type: 'welcome', url: '/student.html' },
    }).catch(e => logger.error('Welcome push failed', { uid, err: e.message }));
  }

  // 4. Alert all admins of the new signup
  const adminsSnap = await db
    .collection('users')
    .where('role', 'in', ['admin', 'super_admin'])
    .get();

  if (!adminsSnap.empty) {
    const batch = db.batch();
    adminsSnap.forEach(d => {
      const ref = d.ref.collection('notifications').doc();
      batch.set(ref, {
        title:     `New student: ${name || email}`,
        body:      `${email} just signed up`,
        type:      'new_signup',
        data:      { uid },
        iconEmoji: '👤',
        read:      false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
  }

  // 5. CEO welcome email (fire-and-forget)
  sendWelcomeEmail({ email, firstName }).catch(() => {});

  logger.info('New student signed up', { uid, email });
  res.status(201).json({ success: true, uid });
}));

// ─── POST /api/users/test-email (admin only) ─────────────────────────────────
// Sends a test welcome email to verify the Gmail SMTP config is working.
// Usage: POST { "email": "target@example.com", "firstName": "Test" }
router.post('/test-email', requireAdmin, asyncHandler(async (req, res) => {
  const { email, firstName = 'Test' } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  const ok = await verifyTransporter();
  if (!ok) {
    return res.status(500).json({
      error: 'SMTP connection failed — check EMAIL_USER and EMAIL_PASS env vars on Render',
    });
  }

  await sendWelcomeEmail({ email, firstName });
  res.json({ success: true, message: `Welcome email dispatched to ${email}` });
}));

module.exports = router;
