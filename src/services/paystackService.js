const axios  = require('axios');
const crypto = require('crypto');

const SECRET_KEY     = process.env.PAYSTACK_SECRET_KEY;
const WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET;

const PLAN_LABELS = {
  pro:   process.env.PLAN_PRO_LABEL   || 'Pro Scholar',
  elite: process.env.PLAN_ELITE_LABEL || 'Elite Bundle',
};

const api = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: { Authorization: `Bearer ${SECRET_KEY}`, 'Content-Type': 'application/json' },
});

/**
 * @param {string} email
 * @param {string} planKey         - 'pro' | 'elite'
 * @param {string} uid             - Firebase UID
 * @param {string} callbackUrl
 * @param {number} amountKobo      - Amount in kobo (100 kobo = ₦1), resolved by the route from Firestore
 * @param {string} [type]          - 'plan_upgrade' | 'lesson_fee'
 */
async function initializePayment(email, planKey, uid, callbackUrl, amountKobo, type = 'plan_upgrade') {
  if (!amountKobo || amountKobo <= 0) throw new Error('amountKobo must be a positive number');

  const amountNaira = Math.round(amountKobo / 100); // stored in metadata for receipt display

  const { data } = await api.post('/transaction/initialize', {
    email,
    amount:       amountKobo,
    currency:     'NGN',
    callback_url: callbackUrl,
    metadata: {
      uid,
      plan:   planKey,
      type,
      amount: amountNaira,   // naira — used by PaymentResultPage receipt
      custom_fields: [
        { display_name: 'Plan',  variable_name: 'plan',  value: PLAN_LABELS[planKey] || planKey },
        { display_name: 'Type',  variable_name: 'type',  value: type },
      ],
    },
  });

  if (!data.status) throw new Error(data.message || 'Paystack initialization failed');
  return {
    authorizationUrl: data.data.authorization_url,
    accessCode:       data.data.access_code,
    reference:        data.data.reference,
  };
}

async function verifyTransaction(reference) {
  const { data } = await api.get(`/transaction/verify/${reference}`);
  if (!data.status) throw new Error(data.message || 'Verification failed');
  const tx = data.data;
  return { status: tx.status, amount: tx.amount, reference: tx.reference, email: tx.customer.email, metadata: tx.metadata };
}

function validateWebhookSignature(rawBody, signature) {
  if (!WEBHOOK_SECRET) { console.warn('⚠️ PAYSTACK_WEBHOOK_SECRET not set'); return true; }
  const hash = crypto.createHmac('sha512', WEBHOOK_SECRET).update(rawBody).digest('hex');
  return hash === signature;
}

module.exports = { initializePayment, verifyTransaction, validateWebhookSignature };