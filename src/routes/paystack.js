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
  await getDb().collection('users').doc(uid).update({ plan, paystackRef:reference, planActivatedAt:admin.firestore.FieldValue.serverTimestamp(), updatedAt:admin.firestore.FieldValue.serverTimestamp() });
}

router.post('/initialize', authLimiter, requireAuth,
  [body('plan').isIn(['pro','elite']), body('callbackUrl').isURL()],
  validate,
  asyncHandler(async (req,res) => {
    const snap=await getDb().collection('users').doc(req.user.uid).get();
    if (!snap.exists) return res.status(404).json({error:'User not found'});
    const email=snap.data().email||req.user.email;
    if (!email) return res.status(400).json({error:'No email on record'});
    const result=await initializePayment(email, req.body.plan, req.user.uid, req.body.callbackUrl);
    logger.info('Paystack checkout initialised', {uid:req.user.uid, plan:req.body.plan});
    res.json({ success:true, ...result });
  })
);

router.get('/verify', requireAuth,
  [query('reference').notEmpty()],
  validate,
  asyncHandler(async (req,res) => {
    const tx=await verifyTransaction(req.query.reference);
    if (tx.status!=='success') return res.status(402).json({error:`Payment not successful: ${tx.status}`});
    const uid=tx.metadata?.uid, plan=tx.metadata?.plan;
    if (uid!==req.user.uid) return res.status(403).json({error:'Transaction does not belong to this account'});
    await upgradePlan(uid, plan, tx.reference);
    logger.info('Plan upgraded via verify', {uid, plan});
    res.json({ success:true, plan, message:`🎉 Welcome to ${plan}! Your plan is now active.` });
  })
);

// ─── GET /api/paystack/callback ─────────────────────────────────────────────
// Paystack redirects the user here after checkout. We verify the transaction
// and redirect them to the frontend with the result.
router.get('/callback', asyncHandler(async (req, res) => {
  const reference = req.query.reference;
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

    const { uid, plan } = tx.metadata || {};

    if (uid && plan) {
      await upgradePlan(uid, plan, tx.reference);
      logger.info('Plan upgraded via callback', { uid, plan });
    }

    return res.redirect(`${frontendUrl}/payment/result?status=success&plan=${plan || ''}&reference=${reference}`);
  } catch (err) {
    logger.error('Callback verification error', { reference, error: err.message });
    return res.redirect(`${frontendUrl}/payment/result?status=error&message=Verification+failed`);
  }
}));

router.post('/webhook', asyncHandler(async (req,res) => {
  if (!validateWebhookSignature(req.rawBody, req.headers['x-paystack-signature'])) {
    logger.warn('Invalid Paystack webhook signature');
    return res.status(401).json({error:'Invalid signature'});
  }

  // Acknowledge immediately — Paystack expects 200 within 5 seconds
  res.status(200).json({received:true});

  const event = req.body;
  logger.info(`Paystack webhook received: ${event.event}`);

  try {
    switch (event.event) {

      case 'charge.success': {
        const { metadata, reference } = event.data;
        if (metadata?.uid && metadata?.plan) {
          await upgradePlan(metadata.uid, metadata.plan, reference);
          logger.info('Plan upgraded via webhook (charge.success)', { uid: metadata.uid, plan: metadata.plan });
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
            plan: 'free',
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
            plan: 'free',
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