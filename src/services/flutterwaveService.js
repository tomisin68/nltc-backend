const axios  = require('axios');
const crypto = require('crypto');

const SECRET_KEY   = process.env.FLUTTERWAVE_SECRET_KEY;
const SECRET_HASH  = process.env.FLUTTERWAVE_SECRET_HASH;

const PLAN_LABELS = {
  pro:   process.env.PLAN_PRO_LABEL   || 'Pro Scholar',
  elite: process.env.PLAN_ELITE_LABEL || 'Elite Bundle',
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
 * @param {string|null} planKey    - 'pro' | 'elite' | null (for lesson_fee)
 * @param {string} uid             - Firebase UID
 * @param {string} callbackUrl
 * @param {number} amountKobo      - Amount in kobo (100 kobo = ₦1); Flutterwave itself is billed in Naira
 * @param {string} [type]          - 'plan_upgrade' | 'lesson_fee'
 * @param {string} [description]   - Human-readable label (class name for lesson_fee, plan label for upgrades)
 */
async function initializePayment(email, planKey, uid, callbackUrl, amountKobo, type = 'plan_upgrade', description = null) {
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

function validateWebhookSignature(rawBody, signature) {
  if (!SECRET_HASH) { console.warn('⚠️ FLUTTERWAVE_SECRET_HASH not set'); return true; }
  return typeof signature === 'string' && signature === SECRET_HASH;
}

module.exports = { initializePayment, verifyTransaction, validateWebhookSignature };
