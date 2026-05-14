const express      = require('express');
const admin        = require('firebase-admin');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const logger       = require('../utils/logger');
const { getDb, getAuth } = require('../../config/firebase');
const { sendWelcomeEmail } = require('../services/emailService');

const router = express.Router();

// ─── GET /api/centers ─────────────────────────────────────────────────────────
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
  const snap = await getDb().collection('centers').orderBy('createdAt', 'desc').get();
  const centers = snap.docs.map(d => ({
    id: d.id, ...d.data(),
    createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null,
  }));
  res.json({ centers });
}));

// ─── POST /api/centers ────────────────────────────────────────────────────────
// Create a new center.
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { name, location, state } = req.body;
  if (!name || !state) return res.status(400).json({ error: 'name and state are required' });

  const ref = await getDb().collection('centers').add({
    name: name.trim(),
    location: location?.trim() || '',
    state: state.trim(),
    managerId: null,
    managerName: '',
    managerEmail: '',
    status: 'active',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: req.user.uid,
  });

  logger.info('Center created', { centerId: ref.id, name, by: req.user.uid });
  res.status(201).json({ success: true, centerId: ref.id });
}));

// ─── PUT /api/centers/:id ─────────────────────────────────────────────────────
router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { name, location, state, status } = req.body;
  const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (name)     update.name     = name.trim();
  if (location) update.location = location.trim();
  if (state)    update.state    = state.trim();
  if (status)   update.status   = status;

  await getDb().collection('centers').doc(req.params.id).update(update);
  res.json({ success: true });
}));

// ─── POST /api/centers/:id/create-manager ─────────────────────────────────────
// Create a Firebase Auth user with role=center_manager and link them to the center.
router.post('/:id/create-manager', requireAdmin, asyncHandler(async (req, res) => {
  const centerId = req.params.id;
  const { email, firstName, lastName, phone = '' } = req.body;
  if (!email || !firstName) return res.status(400).json({ error: 'email and firstName are required' });

  const db           = getDb();
  const authInstance = getAuth();

  // Verify center exists
  const centerSnap = await db.collection('centers').doc(centerId).get();
  if (!centerSnap.exists) return res.status(404).json({ error: 'Center not found' });
  const centerData = centerSnap.data();

  let uid;
  let tempPassword;

  // Create or reuse Firebase Auth user
  try {
    const existing = await authInstance.getUserByEmail(email);
    uid = existing.uid;
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      tempPassword = Math.random().toString(36).slice(-8)
        + Math.random().toString(36).toUpperCase().slice(-4) + '!9';
      const newUser = await authInstance.createUser({
        email,
        password:    tempPassword,
        displayName: `${firstName} ${lastName || ''}`.trim(),
      });
      uid = newUser.uid;
    } else {
      throw e;
    }
  }

  // Upsert Firestore user document
  await db.collection('users').doc(uid).set({
    uid, email,
    firstName: firstName.trim(),
    lastName:  (lastName || '').trim(),
    phone:     phone.trim(),
    role:      'center_manager',
    center:    centerId,
    plan:      'free',
    xp: 0, streak: 0, achievements: [], fcmTokens: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  // Link manager to center
  await db.collection('centers').doc(centerId).update({
    managerId:    uid,
    managerName:  `${firstName} ${lastName || ''}`.trim(),
    managerEmail: email,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Send login credentials email
  const { Resend } = require('resend');
  if (process.env.RESEND_API_KEY) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const fromName  = process.env.EMAIL_FROM_NAME || 'NLTC Online';
      const fromEmail = process.env.RESEND_FROM_EMAIL || 'no-reply@nltc.com.ng';
      await resend.emails.send({
        from:    `${fromName} <${fromEmail}>`,
        to:      email,
        subject: `You have been appointed as Center Manager — ${centerData.name}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
            <h2 style="color:#0B1D3A;">Welcome, ${firstName}!</h2>
            <p>You have been appointed as the <strong>Center Manager</strong> for <strong>${centerData.name}</strong> on the NLTC Online platform.</p>
            <div style="background:#f8f9fc;border-radius:8px;padding:16px;margin:20px 0;">
              <p style="margin:0 0 8px;"><strong>Login Email:</strong> ${email}</p>
              ${tempPassword ? `<p style="margin:0;"><strong>Temporary Password:</strong> <code style="background:#e5e7eb;padding:2px 6px;border-radius:4px;">${tempPassword}</code></p>` : ''}
            </div>
            ${tempPassword ? '<p style="color:#6b7280;font-size:.9rem;">Please change your password after your first login.</p>' : ''}
            <a href="${process.env.FRONTEND_URL || 'https://nltc.com.ng'}/auth" style="display:inline-block;background:#D4A017;color:#0B1D3A;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:8px;">Log In Now</a>
            <p style="color:#9ca3af;font-size:.8rem;margin-top:32px;">&copy; ${new Date().getFullYear()} Next Level Tutorial College</p>
          </div>`,
      });
      logger.info('Center manager welcome email sent', { email, centerId });
    } catch (mailErr) {
      logger.warn('Center manager email failed', { email, err: mailErr.message });
    }
  }

  logger.info('Center manager created', { uid, email, centerId, by: req.user.uid });
  res.status(201).json({ success: true, uid, message: `Center manager ${email} created successfully` });
}));

// ─── GET /api/centers/:id/stats ───────────────────────────────────────────────
// Aggregate stats for a center (admin or the center's manager).
router.get('/:id/stats', requireAuth, asyncHandler(async (req, res) => {
  const centerId = req.params.id;
  const db = getDb();

  // Auth: must be admin or this center's manager
  const snap = await db.collection('users').doc(req.user.uid).get();
  const role = snap.data()?.role;
  const userCenter = snap.data()?.center;
  if (role !== 'admin' && role !== 'super_admin' && !(role === 'center_manager' && userCenter === centerId)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const studentsSnap = await db.collection('users')
    .where('center', '==', centerId)
    .where('role', '==', 'student')
    .get();

  const students = studentsSnap.docs.map(d => d.data());
  const PLAN_PRICE = { free: 0, pro: 2000, elite: 5000 };
  const revenue = students.reduce((sum, s) => sum + (PLAN_PRICE[s.plan] || 0), 0);

  res.json({
    total:   students.length,
    paid:    students.filter(s => s.plan && s.plan !== 'free').length,
    revenue,
    avgXp:   students.length ? Math.round(students.reduce((a, s) => a + (s.xp || 0), 0) / students.length) : 0,
  });
}));

// ─── GET /api/centers/activity-logs ──────────────────────────────────────────
// Admin: view all center manager activity logs.
router.get('/activity-logs', requireAdmin, asyncHandler(async (req, res) => {
  const { centerId, limit: lim = 100 } = req.query;
  let q = getDb().collection('activityLogs').orderBy('createdAt', 'desc').limit(Number(lim));
  if (centerId) q = getDb().collection('activityLogs')
    .where('centerId', '==', centerId).orderBy('createdAt', 'desc').limit(Number(lim));

  const snap = await q.get();
  const logs = snap.docs.map(d => ({
    id: d.id, ...d.data(),
    createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null,
  }));
  res.json({ logs });
}));

module.exports = router;
