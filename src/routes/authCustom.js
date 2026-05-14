const express      = require('express');
const crypto       = require('crypto');
const admin        = require('firebase-admin');
const asyncHandler = require('../utils/asyncHandler');
const logger       = require('../utils/logger');
const { getDb, getAuth } = require('../../config/firebase');
const { Resend }   = require('resend');

const router = express.Router();

const FROM_NAME  = process.env.EMAIL_FROM_NAME  || 'NLTC Online';
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'no-reply@nltc.com.ng';
const FRONTEND   = process.env.FRONTEND_URL      || 'https://nltc.com.ng';

function resend() {
  return new Resend(process.env.RESEND_API_KEY);
}

function buildBrandedEmail({ title, preheader, bodyHtml }) {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${title}</title></head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fa;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.08);">
        <tr><td style="background:#0B1D3A;padding:32px 40px;text-align:center;">
          <p style="margin:0;color:#D4A017;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;">Next Level Tutorial College</p>
          <h1 style="margin:8px 0 0;color:#fff;font-size:24px;font-weight:900;">${title}</h1>
        </td></tr>
        <tr><td style="background:linear-gradient(90deg,#D4A017,#f0be45);height:4px;"></td></tr>
        <tr><td style="padding:36px 40px 32px;">
          ${bodyHtml}
        </td></tr>
        <tr><td style="background:#f8f9fc;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">
            &copy; ${year} Next Level Tutorial College &nbsp;&middot;&nbsp;
            <a href="${FRONTEND}" style="color:#D4A017;text-decoration:none;">nltc.com.ng</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ─── POST /api/auth/request-password-reset ────────────────────────────────────
// Public — no auth required. Generates a secure token and emails a reset link.
router.post('/request-password-reset', asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  const db = getDb();

  // Always return success to avoid email enumeration
  res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });

  // Do the work after responding (fire-and-forget)
  setImmediate(async () => {
    try {
      let uid;
      try {
        const user = await getAuth().getUserByEmail(email.trim());
        uid = user.uid;
      } catch {
        return; // email not found — silently done
      }

      // Generate cryptographically secure token
      const token     = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Invalidate any previous tokens for this user
      const old = await db.collection('passwordResetTokens').where('uid', '==', uid).where('used', '==', false).get();
      const batch = db.batch();
      old.forEach(d => batch.update(d.ref, { used: true }));
      batch.set(db.collection('passwordResetTokens').doc(token), {
        uid, email: email.trim(),
        expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
        used:      false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await batch.commit();

      const resetLink = `${FRONTEND}/reset-password?token=${token}`;

      const html = buildBrandedEmail({
        title: 'Reset Your Password',
        bodyHtml: `
          <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.75;">
            We received a request to reset the password for your NLTC Online account.
          </p>
          <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.75;">
            Click the button below to choose a new password. This link expires in <strong>1 hour</strong>.
          </p>
          <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
            <tr>
              <td style="background:#D4A017;border-radius:10px;">
                <a href="${resetLink}" style="display:inline-block;padding:14px 32px;color:#0B1D3A;font-weight:800;font-size:15px;text-decoration:none;">Reset Password &rarr;</a>
              </td>
            </tr>
          </table>
          <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">If you did not request a password reset, you can safely ignore this email.</p>
          <p style="margin:0;font-size:12px;color:#9ca3af;word-break:break-all;">Or copy this link: ${resetLink}</p>`,
      });

      await resend().emails.send({
        from:    `${FROM_NAME} <${FROM_EMAIL}>`,
        to:      email.trim(),
        subject: 'Reset your NLTC Online password',
        html,
      });

      logger.info('Password reset email sent', { uid, email });
    } catch (err) {
      logger.error('Password reset email failed', { email, err: err.message });
    }
  });
}));

// ─── POST /api/auth/reset-password ───────────────────────────────────────────
// Validates the token and updates the password via Firebase Admin SDK.
router.post('/reset-password', asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'token and newPassword are required' });
  if (newPassword.length < 6)  return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const db  = getDb();
  const ref = db.collection('passwordResetTokens').doc(token);
  const snap = await ref.get();

  if (!snap.exists) return res.status(400).json({ error: 'Invalid or expired reset link' });

  const data = snap.data();
  if (data.used) return res.status(400).json({ error: 'This reset link has already been used' });
  if (data.expiresAt.toDate() < new Date()) return res.status(400).json({ error: 'This reset link has expired' });

  // Update password
  await getAuth().updateUser(data.uid, { password: newPassword });

  // Mark token as used
  await ref.update({ used: true, usedAt: admin.firestore.FieldValue.serverTimestamp() });

  logger.info('Password reset successful', { uid: data.uid });
  res.json({ success: true, message: 'Password updated successfully' });
}));

// ─── POST /api/auth/send-otp ──────────────────────────────────────────────────
// Generates a 6-digit OTP and sends it to the user's email.
router.post('/send-otp', asyncHandler(async (req, res) => {
  const { uid, email } = req.body;
  if (!uid || !email) return res.status(400).json({ error: 'uid and email are required' });

  // Generate 6-digit OTP
  const otp       = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  const db = getDb();
  await db.collection('emailOtps').doc(uid).set({
    otp,
    email,
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    verified:  false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const html = buildBrandedEmail({
    title: 'Verify Your Email',
    bodyHtml: `
      <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.75;">
        Welcome to NLTC Online! Enter the code below to verify your email address.
      </p>
      <div style="background:#f8f9fc;border-radius:12px;padding:28px;text-align:center;margin:0 0 24px;">
        <p style="margin:0 0 6px;font-size:12px;color:#6b7280;letter-spacing:2px;text-transform:uppercase;">Your verification code</p>
        <p style="margin:0;font-size:42px;font-weight:900;color:#0B1D3A;letter-spacing:12px;font-family:monospace;">${otp}</p>
        <p style="margin:8px 0 0;font-size:12px;color:#9ca3af;">Expires in 10 minutes</p>
      </div>
      <p style="margin:0;font-size:13px;color:#6b7280;">If you did not create an NLTC Online account, ignore this email.</p>`,
  });

  await resend().emails.send({
    from:    `${FROM_NAME} <${FROM_EMAIL}>`,
    to:      email,
    subject: `${otp} is your NLTC Online verification code`,
    html,
  });

  logger.info('OTP sent', { uid, email });
  res.json({ success: true });
}));

// ─── POST /api/auth/verify-otp ────────────────────────────────────────────────
// Validates the OTP and marks emailVerified = true in Firebase Auth.
router.post('/verify-otp', asyncHandler(async (req, res) => {
  const { uid, otp } = req.body;
  if (!uid || !otp) return res.status(400).json({ error: 'uid and otp are required' });

  const db   = getDb();
  const snap = await db.collection('emailOtps').doc(uid).get();

  if (!snap.exists) return res.status(400).json({ error: 'No verification pending for this account' });

  const data = snap.data();
  if (data.verified)                       return res.status(400).json({ error: 'Email already verified' });
  if (data.expiresAt.toDate() < new Date()) return res.status(400).json({ error: 'Code expired — request a new one' });
  if (data.otp !== otp.trim())              return res.status(400).json({ error: 'Incorrect code' });

  // Mark verified in Firebase Auth + Firestore
  await getAuth().updateUser(uid, { emailVerified: true });
  await db.collection('emailOtps').doc(uid).update({ verified: true });
  await db.collection('users').doc(uid).update({
    emailVerified: true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  logger.info('Email verified via OTP', { uid });
  res.json({ success: true });
}));

// ─── POST /api/auth/resend-otp ────────────────────────────────────────────────
router.post('/resend-otp', asyncHandler(async (req, res) => {
  const { uid, email } = req.body;
  if (!uid || !email) return res.status(400).json({ error: 'uid and email are required' });

  // Re-use send-otp logic
  req.body = { uid, email };
  const otp       = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  const db = getDb();
  await db.collection('emailOtps').doc(uid).set({
    otp, email,
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    verified:  false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const html = buildBrandedEmail({
    title: 'New Verification Code',
    bodyHtml: `
      <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.75;">Here is your new verification code:</p>
      <div style="background:#f8f9fc;border-radius:12px;padding:28px;text-align:center;margin:0 0 24px;">
        <p style="margin:0 0 6px;font-size:12px;color:#6b7280;letter-spacing:2px;text-transform:uppercase;">Verification code</p>
        <p style="margin:0;font-size:42px;font-weight:900;color:#0B1D3A;letter-spacing:12px;font-family:monospace;">${otp}</p>
        <p style="margin:8px 0 0;font-size:12px;color:#9ca3af;">Expires in 10 minutes</p>
      </div>`,
  });

  await resend().emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to:   email,
    subject: `${otp} is your NLTC Online verification code`,
    html,
  });

  logger.info('OTP resent', { uid, email });
  res.json({ success: true });
}));

module.exports = router;
