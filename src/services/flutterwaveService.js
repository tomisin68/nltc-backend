const axios  = require('axios');
const crypto = require('crypto');

const SECRET_KEY   = process.env.FLUTTERWAVE_SECRET_KEY;
const SECRET_HASH  = process.env.FLUTTERWAVE_SECRET_HASH;

const PLAN_LABELS = {
  pro: process.env.PLAN_PRO_LABEL || 'Pro Scholar',
};

const api = axios.create({
  baseURL: 'https://api.flutterwave.com/v3',
  headers: { Authorization: `Bearer ${SECRET_KEY}`, 'Content-Type': 'application/json' },
  timeout: 15000,
});

function generateTxRef(uid) {
  return `NLTC-${uid.slice(0, 8)}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * @param {string} email
 * @param {string|null} planKey    - 'pro' | null (for lesson_fee)
 * @param {string} uid             - Firebase UID
 * @param {string} callbackUrl
 * @param {number} amountKobo      - Amount in kobo (100 kobo = ₦1); Flutterwave itself is billed in Naira
 * @param {string} [type]          - 'plan_upgrade' | 'lesson_fee'
 * @param {string} [description]   - Human-readable label (class name for lesson_fee, plan label for upgrades)
 * @param {object} [extraMeta]     - Extra key/values echoed back on verify (e.g. classId, classType)
 */
async function initializePayment(email, planKey, uid, callbackUrl, amountKobo, type = 'plan_upgrade', description = null, extraMeta = {}) {
  if (!amountKobo || amountKobo <= 0) throw new Error('amountKobo must be a positive number');

  const amountNaira  = Math.round(amountKobo / 100);
  const displayLabel = description || PLAN_LABELS[planKey] || planKey || type;
  const txRef        = generateTxRef(uid);

  const { data } = await api.post('/payments', {
    tx_ref:       txRef,
    amount:       amountNaira,
    currency:     'NGN',
    redirect_url: callbackUrl,
    customer:     { email },
    customizations: { title: 'NLTC Online', description: displayLabel },
    meta: {
      ...Object.fromEntries(Object.entries(extraMeta).filter(([, v]) => v != null)),
      uid,
      plan:        planKey  || null,
      type,
      amount:      amountNaira,   // naira — used by PaymentResultPage receipt
      description: displayLabel,  // class name or plan label — stored in payment record
    },
  });

  if (data.status !== 'success') throw new Error(data.message || 'Flutterwave initialization failed');
  return {
    authorizationUrl: data.data.link,
    reference:        txRef,
  };
}

function normalizeMeta(tx) {
  if (tx.meta && typeof tx.meta === 'object' && !Array.isArray(tx.meta)) return tx.meta;
  if (Array.isArray(tx.meta_data)) {
    return tx.meta_data.reduce((acc, { metaname, metavalue }) => {
      if (metaname) acc[metaname] = metavalue;
      return acc;
    }, {});
  }
  return {};
}

async function verifyTransaction(reference) {
  const { data } = await api.get('/transactions/verify_by_reference', { params: { tx_ref: reference } });
  if (data.status !== 'success') throw new Error(data.message || 'Verification failed');
  const tx = data.data;
  return {
    status:    tx.status === 'successful' ? 'success' : tx.status,
    amount:    Math.round((tx.amount || 0) * 100), // Naira -> kobo, so callers keep working in kobo
    reference: tx.tx_ref,
    email:     tx.customer?.email,
    metadata:  normalizeMeta(tx),
  };
}

// The webhook grants plans and marks lesson fees paid for whatever uid the
// payload names, so this is the only thing standing between an unauthenticated
// POST and free access for any account.
//
// It used to `return true` when FLUTTERWAVE_SECRET_HASH was unset — one missing
// env var on Render (a typo, a restored-from-scratch service) silently turned
// the endpoint into an open "upgrade anyone" API, with nothing but a console
// warning to say so. It now fails closed: no configured hash, no accepted
// webhook. The comparison is constant-time so the hash cannot be recovered a
// byte at a time from response timing.
function validateWebhookSignature(rawBody, signature) {
  if (!SECRET_HASH) {
    console.error('FLUTTERWAVE_SECRET_HASH is not set — rejecting webhook');
    return false;
  }
  if (typeof signature !== 'string' || signature.length === 0) return false;

  const provided = Buffer.from(signature);
  const expected = Buffer.from(SECRET_HASH);
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

module.exports = { initializePayment, verifyTransaction, validateWebhookSignature };
