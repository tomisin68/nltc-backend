const express        = require('express');
const { body, query }= require('express-validator');
const { requireAuth }= require('../middleware/auth');
const { validate }   = require('../middleware/validate');
const { authLimiter }= require('../middleware/rateLimiter');
const { initializePayment, verifyTransaction, validateWebhookSignature } = require('../services/paystackService');
const asyncHandler   = require('../utils/asyncHandler');
const logger         = require('../utils/logger');
const { getDb }      = require('../../config/firebase');
const admin          = require('firebase-admin');
const router         = express.Router();

async function upgradePlan(uid, plan, reference) {
  await getDb().collection('users').doc(uid).update({
    plan,
    paystackRef:        reference,
    planActivatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function markLessonFeePaid(uid) {
  await getDb().collection('users').doc(uid).update({
    lessonFeePaid: true,
    updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function savePaymentRecord(uid, { reference, type, plan, amount, description, status = 'success' }) {
  try {
    await getDb()
      .collection('users').doc(uid)
      .collection('payments').doc(reference)
      .set({
        uid,
        reference,
        type:        type || 'plan_upgrade',
        plan:        plan || null,
        amount:      amount || 0,
        description: description || (plan ? `${plan} plan upgrade` : 'Lesson fee payment'),
        status,
        createdAt:   admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
  } catch (err) {
    logger.warn('Failed to save payment record', { uid, reference, error: err.message });
  }
}

// ─── POST /api/paystack/initialize ──────────────────────────────────────────
router.post('/initialize', authLimiter, requireAuth,
  [
    body('plan').optional().isIn(['pro', 'elite']),
    body('callbackUrl').isURL(),
    body('type').optional().isIn(['plan_upgrade', 'lesson_fee']),
    body('amount').optional().isInt({ min: 1 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const db  = getDb();
    const uid = req.user.uid;
    const paymentType = req.body.type || 'plan_upgrade';

    if (paymentType === 'plan_upgrade' && !req.body.plan) {
      return res.status(400).json({ error: 'plan is required for plan_upgrade payments' });
    }

    const [userSnap, feesSnap] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('settings').doc('fees').get(),
    ]);

    if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

    const email = userSnap.data().email || req.user.email;
    if (!email)  return res.status(400).json({ error: 'No email on record' });

    const fees = feesSnap.exists ? feesSnap.data() : {};
    const planAmounts = {
      pro:   (fees.proMonthly   || 5000)  * 100,
      elite: (fees.eliteMonthly || 10000) * 100,
    };

    const amountKobo = paymentType === 'lesson_fee'
      ? (req.body.amount || fees.lessonFeeDefault || 5000) * 100
      : planAmounts[req.body.plan];

    // For lesson_fee, pass the class name as description so it appears in payment records.
    const description = paymentType === 'lesson_fee'
      ? (req.body.metadata?.description || req.body.metadata?.className || null)
      : null;

    const result = await initializePayment(
      email,
      req.body.plan,
      uid,
      req.body.callbackUrl,
      amountKobo,
      paymentType,
      description,
    );

    logger.info('Paystack checkout initialised', { uid, plan: req.body.plan, type: paymentType, amountKobo, description });
    res.json({ success: true, ...result });
  })
);

// ─── GET /api/paystack/verify ────────────────────────────────────────────────
router.get('/verify', requireAuth,
  [query('reference').notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const tx = await verifyTransaction(req.query.reference);
    if (tx.status !== 'success') {
      return res.status(402).json({ error: `Payment not successful: ${tx.status}` });
    }

    const { uid, plan, type, amount } = tx.metadata || {};

    if (uid !== req.user.uid) {
      return res.status(403).json({ error: 'Transaction does not belong to this account' });
    }

    if (type === 'lesson_fee') {
      await markLessonFeePaid(uid);
      await savePaymentRecord(uid, {
        reference:   tx.reference,
        type:        'lesson_fee',
        amount:      amount || Math.round((tx.amount || 0) / 100),
        description: tx.metadata?.description || 'Lesson fee payment',
        status:      'success',
      });
      logger.info('Lesson fee verified', { uid, amount });
      return res.json({ success: true, type: 'lesson_fee', amount, message: 'Lesson fee payment confirmed.' });
    }

    await upgradePlan(uid, plan, tx.reference);
    await savePaymentRecord(uid, {
      reference:   tx.reference,
      type:        'plan_upgrade',
      plan,
      amount:      amount || Math.round((tx.amount || 0) / 100),
      description: `${plan} plan upgrade`,
      status:      'success',
    });
    logger.info('Plan upgraded via verify', { uid, plan });
    res.json({ success: true, plan, type: 'plan_upgrade', message: `Welcome to ${plan}! Your plan is now active.` });
  })
);

// ─── GET /api/paystack/history ───────────────────────────────────────────────
router.get('/history', requireAuth, asyncHandler(async (req, res) => {
  const uid  = req.user.uid;
  const snap = await getDb()
    .collection('users').doc(uid)
    .collection('payments')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  const payments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  res.json({ success: true, payments });
}));

// ─── GET /api/paystack/callback ─────────────────────────────────────────────
router.get('/callback', asyncHandler(async (req, res) => {
  const reference  = req.query.reference;
  const frontendUrl = process.env.FRONTEND_URL || 'https://nltc-online.vercel.app';

  if (!reference) {
    return res.redirect(`${frontendUrl}/payment/result?status=error&message=No+reference+returned`);
  }

  try {
    const tx = await verifyTransaction(reference);

    if (tx.status !== 'success') {
      logger.warn('Payment not successful on callback', { reference, status: tx.status });
      return res.redirect(`${frontendUrl}/payment/result?status=failed&reference=${reference}`);
    }

    const { uid, plan, type, amount } = tx.metadata || {};

    if (uid && type !== 'lesson_fee' && plan) {
      await upgradePlan(uid, plan, tx.reference);
      await savePaymentRecord(uid, {
        reference:   tx.reference,
        type:        'plan_upgrade',
        plan,
        amount:      amount || Math.round((tx.amount || 0) / 100),
        description: `${plan} plan upgrade`,
        status:      'success',
      });
      logger.info('Plan upgraded via callback', { uid, plan });
    } else if (uid && type === 'lesson_fee') {
      await markLessonFeePaid(uid);
      await savePaymentRecord(uid, {
        reference:   tx.reference,
        type:        'lesson_fee',
        amount:      amount || Math.round((tx.amount || 0) / 100),
        description: tx.metadata?.description || 'Lesson fee payment',
        status:      'success',
      });
      logger.info('Lesson fee paid via callback', { uid });
    }

    const params = new URLSearchParams({ status: 'success', reference });
    if (plan)   params.set('plan', plan);
    if (type)   params.set('type', type);
    if (amount) params.set('amount', amount);

    return res.redirect(`${frontendUrl}/payment/result?${params.toString()}`);
  } catch (err) {
    logger.error('Callback verification error', { reference, error: err.message });
    return res.redirect(`${frontendUrl}/payment/result?status=error&message=Verification+failed`);
  }
}));

// ─── POST /api/paystack/webhook ──────────────────────────────────────────────
router.post('/webhook', asyncHandler(async (req, res) => {
  if (!validateWebhookSignature(req.rawBody, req.headers['x-paystack-signature'])) {
    logger.warn('Invalid Paystack webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  res.status(200).json({ received: true });

  const event = req.body;
  logger.info(`Paystack webhook received: ${event.event}`);

  try {
    switch (event.event) {

      case 'charge.success': {
        const { metadata, reference } = event.data;
        const uid    = metadata?.uid;
        const plan   = metadata?.plan;
        const type   = metadata?.type;
        const amount = metadata?.amount || Math.round((event.data.amount || 0) / 100);

        if (uid && plan && type !== 'lesson_fee') {
          await upgradePlan(uid, plan, reference);
          await savePaymentRecord(uid, {
            reference, type: 'plan_upgrade', plan, amount,
            description: `${plan} plan upgrade`, status: 'success',
          });
          logger.info('Plan upgraded via webhook (charge.success)', { uid, plan });
        } else if (uid && type === 'lesson_fee') {
          await markLessonFeePaid(uid);
          await savePaymentRecord(uid, {
            reference, type: 'lesson_fee', amount,
            description: metadata?.description || 'Lesson fee payment', status: 'success',
          });
          logger.info('Lesson fee paid via webhook (charge.success)', { uid });
        }
        break;
      }

      case 'subscription.create': {
        const { metadata } = event.data || {};
        if (metadata?.uid && metadata?.plan) {
          await upgradePlan(metadata.uid, metadata.plan, event.data.subscription_code);
          logger.info('Plan activated via webhook (subscription.create)', { uid: metadata.uid, plan: metadata.plan });
        }
        break;
      }

      case 'subscription.disable': {
        const uid = event.data?.metadata?.uid || event.data?.customer?.metadata?.uid;
        if (uid) {
          await getDb().collection('users').doc(uid).update({
            plan:      'free',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          logger.info('Plan downgraded via webhook (subscription.disable)', { uid });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const uid = event.data?.metadata?.uid || event.data?.customer?.metadata?.uid;
        if (uid) {
          await getDb().collection('users').doc(uid).update({
            plan:      'free',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          logger.warn('Plan downgraded — invoice payment failed', { uid });
        }
        break;
      }

      default:
        logger.info(`Unhandled Paystack event: ${event.event}`);
    }
  } catch (err) {
    logger.error('Webhook processing error', { event: event.event, error: err.message });
  }
}));

module.exports = router;
