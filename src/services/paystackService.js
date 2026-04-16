const axios  = require('axios');
const crypto = require('crypto');

const SECRET_KEY     = process.env.PAYSTACK_SECRET_KEY;
const WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET;

const PLANS = {
  pro:   { amount: parseInt(process.env.PLAN_PRO_AMOUNT   || '500000'), label: process.env.PLAN_PRO_LABEL   || 'Pro Scholar' },
  elite: { amount: parseInt(process.env.PLAN_ELITE_AMOUNT || '1200000'), label: process.env.PLAN_ELITE_LABEL || 'Elite Bundle' },
};

const api = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: { Authorization: `Bearer ${SECRET_KEY}`, 'Content-Type': 'application/json' },
});

async function initializePayment(email, planKey, uid, callbackUrl) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error(`Unknown plan: ${planKey}`);
  const { data } = await api.post('/transaction/initialize', {
    email, amount: plan.amount, currency: 'NGN', callback_url: callbackUrl,
    metadata: { uid, plan: planKey, custom_fields: [{ display_name: 'Plan', variable_name: 'plan', value: plan.label }] },
  });
  if (!data.status) throw new Error(data.message || 'Paystack initialization failed');
  return { authorizationUrl: data.data.authorization_url, accessCode: data.data.access_code, reference: data.data.reference };
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

module.exports = { initializePayment, verifyTransaction, validateWebhookSignature, PLANS };