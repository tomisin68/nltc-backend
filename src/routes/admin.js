const express        = require('express');
const admin          = require('firebase-admin');
const { requireSuperAdmin } = require('../middleware/auth');
const asyncHandler   = require('../utils/asyncHandler');
const logger         = require('../utils/logger');
const { getDb, getAuth } = require('../../config/firebase');

const router = express.Router();

// All admin-management routes require super_admin
router.use(requireSuperAdmin);

// ─── GET /api/admin/list ─────────────────────────────────────────────────────
router.get('/list', asyncHandler(async (req, res) => {
  const snap = await getDb()
    .collection('users')
    .where('role', 'in', ['admin', 'super_admin'])
    .get();

  const admins = snap.docs.map(d => ({
    uid:       d.id,
    firstName: d.data().firstName || '',
    lastName:  d.data().lastName  || '',
    email:     d.data().email     || '',
    role:      d.data().role,
    createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null,
  }));

  res.json({ admins });
}));

// ─── POST /api/admin/add ─────────────────────────────────────────────────────
router.post('/add', asyncHandler(async (req, res) => {
  const { email, firstName, lastName, role = 'admin' } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'email is required' });
  }
  if (!['admin', 'super_admin'].includes(role)) {
    return res.status(400).json({ error: 'role must be "admin" or "super_admin"' });
  }

  const db           = getDb();
  const authInstance = getAuth();
  let   uid;

  // Try to find an existing Firebase Auth user; create one if not found
  try {
    const existing = await authInstance.getUserByEmail(email);
    uid = existing.uid;
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      // Generate a secure temporary password (user should reset via email link)
      const tempPassword = Math.random().toString(36).slice(-8)
        + Math.random().toString(36).toUpperCase().slice(-4)
        + '!1';
      const newUser = await authInstance.createUser({
        email,
        password:      tempPassword,
        displayName:   `${firstName || ''} ${lastName || ''}`.trim(),
        emailVerified: false,
      });
      uid = newUser.uid;
      logger.info('New Firebase Auth user created for admin', { uid, email });
    } else {
      throw e;
    }
  }

  // Set custom claims
  await authInstance.setCustomUserClaims(uid, { role });

  // Upsert Firestore user document
  await db.collection('users').doc(uid).set(
    {
      uid,
      email,
      firstName: firstName || '',
      lastName:  lastName  || '',
      role,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // Send welcome email if Resend is configured
  if (process.env.RESEND_API_KEY) {
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from:    process.env.RESEND_FROM_EMAIL || 'no-reply@nltc.ng',
        to:      email,
        subject: 'You have been added as an NLTC Admin',
        text:    `Hi ${firstName || ''},\n\nYou have been granted ${role} access to the NLTC platform.\n\nLogin at: ${process.env.FRONTEND_URL || 'https://nltc-online.web.app'}\n\nNLTC Team`,
      });
      logger.info('Welcome email sent to new admin', { email });
    } catch (mailErr) {
      // Non-fatal — log and continue
      logger.warn('Admin welcome email failed', { email, err: mailErr.message });
    }
  }

  logger.info('Admin added', { uid, email, role, addedBy: req.user.uid });
  res.json({ success: true, uid, message: `Admin ${email} added successfully` });
}));

// ─── POST /api/admin/remove ──────────────────────────────────────────────────
router.post('/remove', asyncHandler(async (req, res) => {
  const { uid } = req.body;
  if (!uid) {
    return res.status(400).json({ error: 'uid is required' });
  }

  // Prevent super admin from revoking their own access
  if (uid === req.user.uid) {
    return res.status(400).json({ error: 'You cannot revoke your own admin access' });
  }

  const authInstance = getAuth();

  // Clear custom claims
  await authInstance.setCustomUserClaims(uid, {});

  // Update Firestore role
  await getDb().collection('users').doc(uid).update({
    role:      'revoked',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  logger.info('Admin removed', { uid, removedBy: req.user.uid });
  res.json({ success: true, message: 'Admin access revoked' });
}));

module.exports = router;
