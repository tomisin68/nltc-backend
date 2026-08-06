const express         = require('express');
const { body, param, query } = require('express-validator');
const crypto          = require('crypto');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate }    = require('../middleware/validate');
const { authLimiter } = require('../middleware/rateLimiter');
const { resolveBankAccount } = require('../config/bankAccount');
const { sendInAppNotification, sendPushToTokens } = require('../services/notificationService');
const {
  sendAdminPaymentReceiptEmail, sendPaymentConfirmedEmail, sendPaymentRejectedEmail,
} = require('../services/emailService');
const asyncHandler    = require('../utils/asyncHandler');
const logger          = require('../utils/logger');
const { getDb }       = require('../../config/firebase');
const admin           = require('firebase-admin');
const router          = express.Router();

const ACCESS_DAYS = 30;
const ACCESS_MS   = ACCESS_DAYS * 24 * 60 * 60 * 1000;

// ─── Access grants ──────────────────────────────────────────────────────────

async function upgradePlan(uid, plan, reference) {
  const expiresAt = new Date(Date.now() + ACCESS_MS);
  await getDb().collection('users').doc(uid).update({
    plan,
    paymentRef:      reference,
    planActivatedAt: admin.firestore.FieldValue.serverTimestamp(),
    planExpiresAt:   expiresAt,
    updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function markLessonFeePaid(uid, meta = {}) {
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + ACCESS_MS);
  const patch = {
    lessonFeePaid:      true,
    lessonFeePaidAt:    admin.firestore.Timestamp.fromDate(now),
    lessonFeeExpiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    // The lesson fee is what unlocks the platform, so grant the plan on the
    // same dated window. Without an expiry a 'pro' plan would outlive the fee
    // and the account would never lock again.
    plan:               'pro',
    planActivatedAt:    admin.firestore.Timestamp.fromDate(now),
    planExpiresAt:      admin.firestore.Timestamp.fromDate(expiresAt),
    updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
  };
  // Remember which class was paid for, so admin fee views show the right amount
  if (meta.classId)   patch.classId   = meta.classId;
  if (meta.className) patch.className = meta.className;
  if (meta.classType) patch.classType = meta.classType;
  await getDb().collection('users').doc(uid).update(patch);
}

function buildPeriodMeta() {
  const now   = new Date();
  const label = now.toLocaleString('en-NG', { month: 'long', year: 'numeric' }); // e.g. "May 2026"
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end   = new Date(now.getTime() + ACCESS_MS);
  return { periodLabel: label, periodStart: start, periodEnd: end };
}

/**
 * Writes the row the student sees in Payment History.
 *
 * [isNew] stamps `createdAt`. Approval merges over the same document, and
 * re-stamping it there would move a payment made on the 1st to the day an admin
 * got round to it — which is exactly the date the history table sorts on.
 */
async function savePaymentRecord(uid, { reference, type, plan, amount, description, status, method, isNew = false }) {
  const base = {
    uid,
    reference,
    type:        type || 'lesson_fee',
    plan:        plan || null,
    amount:      amount || 0,
    description: description || (plan ? `${plan} plan upgrade` : 'Lesson fee payment'),
    method:      method || 'bank_transfer',
    status,
    updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
  };
  if (isNew) base.createdAt = admin.firestore.FieldValue.serverTimestamp();
  if (type === 'lesson_fee') {
    const { periodLabel, periodStart, periodEnd } = buildPeriodMeta();
    base.periodLabel = periodLabel;
    base.periodStart = admin.firestore.Timestamp.fromDate(periodStart);
    base.periodEnd   = admin.firestore.Timestamp.fromDate(periodEnd);
  }
  await getDb()
    .collection('users').doc(uid)
    .collection('payments').doc(reference)
    .set(base, { merge: true });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateReference(uid) {
  return `NLTC-${uid.slice(0, 8)}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Prices what the student is claiming to have paid for, server-side.
 *
 * The amount is never taken from the request. A manual payment is confirmed by
 * a human looking at a receipt, and the figure this returns is the one shown to
 * that admin — so a client-supplied amount would let a student have ₦1 recorded
 * against a ₦20,000 class and hope the reviewer waves it through.
 *
 * Returns `{ error, status }` instead of throwing so the caller can answer with
 * the right HTTP code.
 */
async function priceSubmission(db, { paymentType, plan, classId, isApp }) {
  if (paymentType === 'lesson_fee') {
    if (!classId) {
      return { error: 'metadata.classId is required for lesson_fee payments', status: 400 };
    }

    const classSnap = await db.collection('classes').doc(String(classId)).get();
    if (!classSnap.exists) return { error: 'That class no longer exists', status: 404 };

    const cls = classSnap.data();
    if (cls.active === false) {
      return { error: 'That class is not open for payment', status: 409 };
    }

    const price = Number(cls.price);
    if (!Number.isFinite(price) || price <= 0) {
      logger.error('Class has no usable price', { classId, price: cls.price });
      return { error: 'That class has no price set. Please contact support.', status: 409 };
    }

    return {
      amount:      Math.round(price),
      description: cls.name || 'Lesson fee payment',
      meta: {
        classId:   String(classId),
        classType: cls.type || 'general',
        className: cls.name || null,
      },
    };
  }

  const feesSnap = await db.collection('settings').doc('fees').get();
  const fees     = feesSnap.exists ? feesSnap.data() : {};

  // The mobile app charges its own activation price, held in a separate
  // settings field so changing the app price never silently moves the
  // website's monthly plan price (and vice versa).
  const amount = isApp ? (fees.appActivation || 3000) : (fees.proMonthly || 2000);

  return {
    amount:      Math.round(amount),
    description: `${plan} plan upgrade`,
    meta:        {},
  };
}

/**
 * Checks the uploaded receipt actually belongs to this student.
 *
 * Storage rules already confine writes to `paymentProofs/{uid}/…`, but the URL
 * recorded on the proof is what an admin opens and what the approval is made
 * on. Without this check a student could upload nothing and submit a link to
 * someone else's receipt — or to any page at all — and the reviewer would be
 * approving a document the platform never received.
 */
function validateReceipt({ receiptUrl, receiptPath, uid }) {
  const expectedPrefix = `paymentProofs/${uid}/`;
  if (typeof receiptPath !== 'string' || !receiptPath.startsWith(expectedPrefix)) {
    return 'Receipt path does not belong to this account';
  }
  // No '..' games that could resolve the stored path outside the user's folder.
  if (receiptPath.includes('..')) return 'Invalid receipt path';

  let url;
  try {
    url = new URL(receiptUrl);
  } catch {
    return 'Invalid receipt URL';
  }
  if (url.protocol !== 'https:') return 'Receipt URL must be https';

  const host = url.hostname.toLowerCase();
  const isFirebaseStorage =
    host === 'firebasestorage.googleapis.com' ||
    host === 'storage.googleapis.com' ||
    host.endsWith('.firebasestorage.app') ||
    host.endsWith('.firebasestorage.googleapis.com');
  if (!isFirebaseStorage) return 'Receipt must be uploaded to NLTC storage';

  // The path is percent-encoded inside the download URL, so compare on the
  // decoded form rather than trusting a substring match.
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return 'Invalid receipt URL';
  }
  if (!decoded.includes(expectedPrefix)) {
    return 'Receipt URL does not match the uploaded file';
  }

  return null;
}

/**
 * Fans a notification out to every admin: in-app row, push, and email.
 *
 * All three, because an unreviewed receipt is a student who has paid and cannot
 * get in. An admin who is not at the console that day should still find out.
 *
 * [email] carries the fields the email template needs; push and email are both
 * best-effort — a dead token or a Resend outage must not fail the student's
 * submission, which has already been recorded by the time this runs.
 */
async function notifyAdmins(db, { title, body, type, data, iconEmoji, email }) {
  const snap = await db.collection('users').where('role', 'in', ['admin', 'super_admin']).get();
  if (snap.empty) return;

  const tokens    = [];
  const addresses = [];
  const batch     = db.batch();

  snap.forEach(d => {
    const u = d.data();
    tokens.push(...(u.fcmTokens || []));
    if (u.email) addresses.push(u.email);
    const ref = d.ref.collection('notifications').doc();
    batch.set(ref, {
      title, body, type,
      data:      data || {},
      iconEmoji: iconEmoji || '🧾',
      read:      false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  await batch.commit();

  if (tokens.length) {
    sendPushToTokens(tokens, { title, body, data: data || {} })
      .catch(e => logger.error('Admin payment push failed', { err: e.message }));
  }

  if (email) {
    for (const adminEmail of addresses) {
      sendAdminPaymentReceiptEmail({ adminEmail, ...email })
        .catch(e => logger.error('Admin payment email failed', { adminEmail, err: e.message }));
    }
  }
}

/**
 * Tells a student what happened to their receipt: in-app row plus push.
 *
 * Both outcomes go through here. A rejection used to write the in-app row only,
 * so the one notification a student actually needs to act on — re-upload a
 * clearer receipt — was the one that never reached their phone.
 *
 * [pushBody] is the shorter line for the notification tray, where the full
 * in-app text would be truncated anyway.
 */
async function notifyStudent(db, uid, { title, body, pushBody, type, data, iconEmoji, email }) {
  await sendInAppNotification(uid, { title, body, type, data, iconEmoji });

  const userSnap = await db.collection('users').doc(uid).get();
  const user = userSnap.exists ? userSnap.data() : {};

  const tokens = user.fcmTokens || [];
  if (tokens.length) {
    // Not awaited: a dead token must not stop the email that follows it.
    sendPushToTokens(tokens, {
      title,
      body: pushBody || body,
      data: { ...(data || {}), type },
    }).catch(e => logger.error('Student payment push failed', { uid, err: e.message }));
  }

  // [email] is { send, payload } — the template to use and what it needs. The
  // address and first name come from the profile rather than the caller, so
  // they cannot go stale against a proof written days earlier.
  if (email && user.email) {
    email.send({ email: user.email, firstName: user.firstName, ...email.payload })
      .catch(e => logger.error('Student payment email failed', { uid, err: e.message }));
  }
}

function serialiseProof(doc) {
  const d = doc.data();
  const ms = v => (v && typeof v.toMillis === 'function' ? v.toMillis() : v || null);
  return {
    id:            doc.id,
    uid:           d.uid,
    reference:     d.reference,
    type:          d.type,
    plan:          d.plan || null,
    amount:        d.amount || 0,
    description:   d.description || null,
    classId:       d.classId || null,
    className:     d.className || null,
    classType:     d.classType || null,
    status:        d.status,
    receiptUrl:    d.receiptUrl,
    receiptName:   d.receiptName || null,
    receiptType:   d.receiptType || null,
    studentName:   d.studentName || null,
    studentEmail:  d.studentEmail || null,
    studentPhone:  d.studentPhone || null,
    note:          d.note || null,
    reviewNote:    d.reviewNote || null,
    reviewedBy:    d.reviewedBy || null,
    reviewedByName: d.reviewedByName || null,
    source:        d.source || 'web',
    createdAt:     ms(d.createdAt),
    reviewedAt:    ms(d.reviewedAt),
  };
}

// ─── GET /api/payments/bank-account (public) ────────────────────────────────
//
// Public on purpose: the details are payment instructions, not a secret, and
// the pricing page shows them before a student has an account.
router.get('/bank-account', asyncHandler(async (req, res) => {
  let override = null;
  try {
    const snap = await getDb().collection('settings').doc('bankAccount').get();
    if (snap.exists) override = snap.data();
  } catch (err) {
    // Firestore unavailable — the hard-coded account is still correct.
    logger.warn('Could not read bank account override', { error: err.message });
  }
  res.json({ success: true, bankAccount: resolveBankAccount(override) });
}));

// ─── GET /api/payments/quote (auth) ─────────────────────────────────────────
//
// What the student will be asked to transfer, priced by the same code that
// prices the submission — so the figure on the transfer screen cannot drift
// from the one an admin ends up reviewing.
router.get('/quote', requireAuth,
  [
    query('type').optional().isIn(['plan_upgrade', 'lesson_fee']),
    query('plan').optional().isIn(['pro']),
    query('classId').optional().isString().trim().notEmpty(),
    query('source').optional().isIn(['web', 'app']),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const paymentType = req.query.type || 'lesson_fee';
    const plan        = req.query.plan || (paymentType === 'plan_upgrade' ? 'pro' : null);

    if (paymentType === 'plan_upgrade' && !plan) {
      return res.status(400).json({ error: 'plan is required for plan_upgrade payments' });
    }

    const priced = await priceSubmission(getDb(), {
      paymentType,
      plan,
      classId: req.query.classId,
      isApp:   req.query.source === 'app',
    });
    if (priced.error) return res.status(priced.status).json({ error: priced.error });

    res.json({
      success:     true,
      type:        paymentType,
      amount:      priced.amount,
      description: priced.description,
    });
  })
);

// ─── POST /api/payments/proof (auth) ────────────────────────────────────────
//
// A student says "I have transferred, here is the receipt". This grants nothing
// on its own — an admin approves it.
router.post('/proof', authLimiter, requireAuth,
  [
    body('type').optional().isIn(['plan_upgrade', 'lesson_fee']),
    body('plan').optional().isIn(['pro']),
    body('receiptUrl').isURL({ protocols: ['https'], require_protocol: true }),
    body('receiptPath').isString().trim().notEmpty(),
    body('receiptName').optional().isString().trim().isLength({ max: 200 }),
    body('receiptType').optional().isString().trim().isLength({ max: 100 }),
    body('note').optional().isString().trim().isLength({ max: 500 }),
    body('source').optional().isIn(['web', 'app']),
    body('metadata.classId').optional().isString().trim().notEmpty(),
    // NB: no body('amount') — the price is looked up server-side from the class
    // document / settings.fees. Anything the caller sends is ignored.
  ],
  validate,
  asyncHandler(async (req, res) => {
    const db  = getDb();
    const uid = req.user.uid;
    const paymentType = req.body.type || 'lesson_fee';
    const plan        = req.body.plan || (paymentType === 'plan_upgrade' ? 'pro' : null);

    if (paymentType === 'plan_upgrade' && !plan) {
      return res.status(400).json({ error: 'plan is required for plan_upgrade payments' });
    }

    const receiptError = validateReceipt({
      receiptUrl:  req.body.receiptUrl,
      receiptPath: req.body.receiptPath,
      uid,
    });
    if (receiptError) {
      logger.warn('Rejected payment proof receipt', { uid, reason: receiptError });
      return res.status(400).json({ error: receiptError });
    }

    // Only images and PDFs — that is what the upload UI offers and what a
    // reviewer can actually open in the admin console.
    const receiptType = req.body.receiptType || '';
    if (receiptType && !/^image\/|^application\/pdf$/.test(receiptType)) {
      return res.status(400).json({ error: 'Receipt must be an image or a PDF' });
    }

    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });
    const user = userSnap.data();

    // One open submission at a time. Without this a student who taps twice —
    // or who is impatient after ten minutes — buries the review queue in
    // duplicates of the same transfer, and every duplicate is a chance for an
    // admin to grant a second 30-day window for one payment.
    const pendingSnap = await db.collection('paymentProofs')
      .where('uid', '==', uid)
      .where('status', '==', 'pending')
      .limit(1)
      .get();
    if (!pendingSnap.empty) {
      return res.status(409).json({
        error: 'You already have a receipt awaiting review. We will confirm it shortly.',
        proof: serialiseProof(pendingSnap.docs[0]),
      });
    }

    const priced = await priceSubmission(db, {
      paymentType,
      plan,
      classId: req.body.metadata?.classId,
      isApp:   req.body.source === 'app',
    });
    if (priced.error) return res.status(priced.status).json({ error: priced.error });

    const reference   = generateReference(uid);
    const studentName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email || uid;

    const proof = {
      uid,
      reference,
      type:         paymentType,
      plan:         plan || null,
      amount:       priced.amount,
      description:  priced.description,
      ...priced.meta,
      status:       'pending',
      method:       'bank_transfer',
      receiptUrl:   req.body.receiptUrl,
      receiptPath:  req.body.receiptPath,
      receiptName:  req.body.receiptName || null,
      receiptType:  receiptType || null,
      note:         req.body.note || null,
      studentName,
      studentEmail: user.email || req.user.email || null,
      studentPhone: user.phone || null,
      center:       user.center || null,
      source:       req.body.source || 'web',
      createdAt:    admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection('paymentProofs').doc(reference).set(proof);

    // A pending row in the student's own history, so the payment is visible to
    // them from the moment they submit rather than only once it is approved.
    await savePaymentRecord(uid, {
      reference,
      type:        paymentType,
      plan,
      amount:      priced.amount,
      description: priced.description,
      status:      'pending',
      isNew:       true,
    }).catch(err => logger.warn('Failed to save pending payment record', { uid, reference, error: err.message }));

    notifyAdmins(db, {
      title: 'New payment receipt',
      body:  `${studentName} uploaded a receipt for ₦${priced.amount.toLocaleString('en-NG')} — ${priced.description}`,
      type:  'payment_proof',
      data:  { proofId: reference, uid, amount: String(priced.amount) },
      iconEmoji: '🧾',
      email: {
        studentName,
        studentEmail: proof.studentEmail,
        amount:       priced.amount,
        description:  priced.description,
        receiptUrl:   req.body.receiptUrl,
      },
    }).catch(err => logger.error('Failed to notify admins of payment proof', { reference, error: err.message }));

    logger.info('Payment proof submitted', { uid, reference, type: paymentType, amount: priced.amount });

    const saved = await db.collection('paymentProofs').doc(reference).get();
    res.status(201).json({ success: true, proof: serialiseProof(saved) });
  })
);

// ─── GET /api/payments/proofs/mine (auth) ───────────────────────────────────
router.get('/proofs/mine', requireAuth, asyncHandler(async (req, res) => {
  const snap = await getDb().collection('paymentProofs')
    .where('uid', '==', req.user.uid)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();
  res.json({ success: true, proofs: snap.docs.map(serialiseProof) });
}));

// ─── GET /api/payments/history (auth) ───────────────────────────────────────
router.get('/history', requireAuth, asyncHandler(async (req, res) => {
  const snap = await getDb()
    .collection('users').doc(req.user.uid)
    .collection('payments')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  res.json({ success: true, payments: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
}));

// ─── GET /api/payments/proofs (admin) ───────────────────────────────────────
router.get('/proofs', requireAdmin,
  [query('status').optional().isIn(['pending', 'approved', 'rejected', 'all'])],
  validate,
  asyncHandler(async (req, res) => {
    const status = req.query.status || 'pending';
    let q = getDb().collection('paymentProofs');
    if (status !== 'all') q = q.where('status', '==', status);
    const snap = await q.orderBy('createdAt', 'desc').limit(200).get();
    res.json({ success: true, proofs: snap.docs.map(serialiseProof) });
  })
);

// ─── POST /api/payments/proofs/:id/approve (admin) ──────────────────────────
router.post('/proofs/:id/approve', requireAdmin,
  [
    param('id').isString().trim().notEmpty(),
    body('note').optional().isString().trim().isLength({ max: 500 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const db  = getDb();
    const ref = db.collection('paymentProofs').doc(req.params.id);

    // Claim the proof in a transaction. Two admins opening the queue and both
    // hitting Approve is the ordinary case, not a rare one, and each approval
    // grants another 30 days — so the second one must lose rather than extend.
    let proof;
    try {
      proof = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw Object.assign(new Error('Receipt not found'), { status: 404 });
        const data = snap.data();
        if (data.status !== 'pending') {
          throw Object.assign(new Error(`This receipt was already ${data.status}`), { status: 409 });
        }
        tx.update(ref, {
          status:         'approved',
          reviewedAt:     admin.firestore.FieldValue.serverTimestamp(),
          reviewedBy:     req.user.uid,
          reviewedByName: req.userData?.firstName
            ? `${req.userData.firstName} ${req.userData.lastName || ''}`.trim()
            : (req.user.email || null),
          reviewNote:     req.body.note || null,
        });
        return data;
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }

    const { uid, reference, type, plan, amount, description } = proof;

    if (type === 'lesson_fee') {
      await markLessonFeePaid(uid, proof);
    } else {
      await upgradePlan(uid, plan || 'pro', reference);
    }

    await savePaymentRecord(uid, {
      reference, type, plan, amount,
      description: description || (type === 'lesson_fee' ? 'Lesson fee payment' : `${plan} plan upgrade`),
      status: 'success',
    });

    const expiresAt = new Date(Date.now() + ACCESS_MS);
    const prettyExpiry = expiresAt.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });

    notifyStudent(db, uid, {
      title:    'Payment confirmed 🎉',
      body:     `Your ₦${(amount || 0).toLocaleString('en-NG')} payment for ${description || 'your fee'} has been confirmed. Your account is active until ${prettyExpiry}.`,
      pushBody: 'Your account is now active. Tap to start learning.',
      type:     'payment_approved',
      data:     { reference, amount: String(amount || 0) },
      iconEmoji: '✅',
      email: {
        send: sendPaymentConfirmedEmail,
        payload: {
          amount,
          description: description || 'Monthly fee',
          reference,
          expiresAt,
        },
      },
    }).catch(err => logger.error('Failed to notify student of approval', { uid, reference, error: err.message }));

    logger.info('Payment proof approved', { reference, uid, by: req.user.uid, amount });
    res.json({ success: true, status: 'approved', reference, expiresAt: expiresAt.toISOString() });
  })
);

// ─── POST /api/payments/proofs/:id/reject (admin) ───────────────────────────
router.post('/proofs/:id/reject', requireAdmin,
  [
    param('id').isString().trim().notEmpty(),
    body('reason').isString().trim().isLength({ min: 1, max: 500 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const db  = getDb();
    const ref = db.collection('paymentProofs').doc(req.params.id);
    const reason = req.body.reason.trim();

    let proof;
    try {
      proof = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw Object.assign(new Error('Receipt not found'), { status: 404 });
        const data = snap.data();
        if (data.status !== 'pending') {
          throw Object.assign(new Error(`This receipt was already ${data.status}`), { status: 409 });
        }
        tx.update(ref, {
          status:         'rejected',
          reviewedAt:     admin.firestore.FieldValue.serverTimestamp(),
          reviewedBy:     req.user.uid,
          reviewedByName: req.userData?.firstName
            ? `${req.userData.firstName} ${req.userData.lastName || ''}`.trim()
            : (req.user.email || null),
          reviewNote:     reason,
        });
        return data;
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }

    const { uid, reference, type, plan, amount, description } = proof;

    await savePaymentRecord(uid, {
      reference, type, plan, amount,
      description: description || 'Payment',
      status: 'failed',
    }).catch(err => logger.warn('Failed to mark payment record failed', { reference, error: err.message }));

    notifyStudent(db, uid, {
      title:    'Payment receipt not accepted',
      body:     `We could not confirm your ₦${(amount || 0).toLocaleString('en-NG')} payment. Reason: ${reason}. Please upload a clearer receipt or contact support.`,
      pushBody: `${reason} — tap to upload a new receipt.`,
      type:     'payment_rejected',
      data:     { reference, reason },
      iconEmoji: '⚠️',
      email: {
        send: sendPaymentRejectedEmail,
        payload: { amount, description: description || 'Monthly fee', reason },
      },
    }).catch(err => logger.error('Failed to notify student of rejection', { uid, reference, error: err.message }));

    logger.info('Payment proof rejected', { reference, uid, by: req.user.uid, reason });
    res.json({ success: true, status: 'rejected', reference });
  })
);

module.exports = router;
