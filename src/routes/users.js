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

  // 1. Check existing role so on-signup never downgrades admin → student
  const existing = await db.collection('users').doc(uid).get();
  const existingRole = existing.exists ? existing.data().role : null;
  const protectedRoles = ['admin', 'super_admin', 'teacher', 'center_manager'];
  const assignedRole = protectedRoles.includes(existingRole) ? existingRole : 'student';

  // 2. Create / merge the user document
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
      role:         assignedRole,
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

// ─── POST /api/users/create-admin (admin only) ───────────────────────────────
// Creates a Firebase Auth user with role=admin and emails them their credentials.
router.post('/create-admin', requireAdmin, asyncHandler(async (req, res) => {
  const { email, firstName, lastName = '', phone = '' } = req.body;
  if (!email || !firstName) return res.status(400).json({ error: 'email and firstName are required' });

  const db           = getDb();
  const authInstance = admin.auth();

  let uid, tempPassword;

  try {
    const existing = await authInstance.getUserByEmail(email);
    uid = existing.uid;
    // Existing account: update role in Firestore, no new password
    await db.collection('users').doc(uid).set({
      uid, email,
      firstName: firstName.trim(),
      lastName:  lastName.trim(),
      phone:     phone.trim(),
      role:      'admin',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      tempPassword = Math.random().toString(36).slice(-8)
        + Math.random().toString(36).toUpperCase().slice(-4) + '!7';
      const newUser = await authInstance.createUser({
        email,
        password:    tempPassword,
        displayName: `${firstName} ${lastName}`.trim(),
      });
      uid = newUser.uid;
      await db.collection('users').doc(uid).set({
        uid, email,
        firstName: firstName.trim(),
        lastName:  lastName.trim(),
        phone:     phone.trim(),
        role:      'admin',
        plan:      'free',
        xp: 0, streak: 0, achievements: [], fcmTokens: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      throw e;
    }
  }

  // Email credentials
  const { Resend } = require('resend');
  if (process.env.RESEND_API_KEY) {
    try {
      const resend     = new Resend(process.env.RESEND_API_KEY);
      const fromName   = process.env.EMAIL_FROM_NAME  || 'NLTC Online';
      const fromEmail  = process.env.RESEND_FROM_EMAIL || 'no-reply@nltc.com.ng';
      const loginUrl   = `${process.env.FRONTEND_URL || 'https://nltc.com.ng'}/auth`;
      await resend.emails.send({
        from:    `${fromName} <${fromEmail}>`,
        to:      email,
        subject: 'You have been added as an NLTC Online Admin',
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
            <h2 style="color:#0B1D3A;">Welcome, ${firstName}!</h2>
            <p>You have been granted <strong>Admin</strong> access to the NLTC Online platform.</p>
            <div style="background:#f8f9fc;border-radius:8px;padding:16px;margin:20px 0;">
              <p style="margin:0 0 8px;"><strong>Login Email:</strong> ${email}</p>
              ${tempPassword ? `<p style="margin:0;"><strong>Temporary Password:</strong> <code style="background:#e5e7eb;padding:2px 6px;border-radius:4px;">${tempPassword}</code></p>` : ''}
            </div>
            ${tempPassword ? '<p style="color:#6b7280;font-size:.9rem;">Please change your password after your first login.</p>' : ''}
            <a href="${loginUrl}" style="display:inline-block;background:#D4A017;color:#0B1D3A;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:8px;">Log In Now</a>
            <p style="color:#9ca3af;font-size:.8rem;margin-top:32px;">&copy; ${new Date().getFullYear()} Next Level Tutorial College</p>
          </div>`,
      });
    } catch (mailErr) {
      logger.warn('Admin welcome email failed', { email, err: mailErr.message });
    }
  }

  logger.info('Admin account created', { uid, email, by: req.user.uid });
  res.status(201).json({ success: true, uid, message: `Admin account for ${email} created successfully` });
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
