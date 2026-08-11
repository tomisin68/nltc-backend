/**
 * The Pro packages an online student can buy.
 *
 * One catalogue, used by three things that must never disagree: the quote the
 * student is shown before transferring, the price recorded against the receipt
 * an admin reviews, and the length of access an approval grants. Those used to
 * be three separate constants — a 30-day grant hard-coded next to a price read
 * from settings — which is fine while there is one plan and wrong the moment
 * there are four.
 *
 * Prices are defaults. An admin can move any of them from `settings/fees`
 * without a deploy; `feeKey` is where that override lives.
 *
 * Centre (physical) students are not billed from here at all — they pay their
 * centre's monthly lesson fee, priced from the class document.
 */

/** Days granted per package. Months are the label; days are the grant. */
const PRO_PLANS = [
  {
    id: 'pro_monthly',
    cycle: 'monthly',
    label: 'Monthly',
    period: 'per month',
    months: 1,
    days: 30,
    feeKey: 'proMonthly',
    defaultPrice: 3000,
  },
  {
    id: 'pro_quarterly',
    cycle: 'quarterly',
    label: 'Quarterly',
    period: 'every 3 months',
    months: 3,
    days: 91,
    feeKey: 'proQuarterly',
    defaultPrice: 10000,
  },
  {
    id: 'pro_biannual',
    cycle: 'biannual',
    label: '6 Months',
    period: 'every 6 months',
    months: 6,
    days: 182,
    feeKey: 'proBiannual',
    defaultPrice: 15000,
  },
  {
    id: 'pro_yearly',
    cycle: 'yearly',
    label: 'Yearly',
    period: 'per year',
    months: 12,
    days: 365,
    feeKey: 'proYearly',
    defaultPrice: 30000,
  },
];

/** The package a bare `pro` means — what every client sent before tiers existed. */
const DEFAULT_PLAN_ID = 'pro_monthly';

/**
 * Everything a client may send as `plan`.
 *
 * `pro` stays accepted forever: receipts submitted by an older app build are
 * still in the queue, and rejecting them at approval time would strand a
 * student who has already transferred.
 */
const PLAN_IDS = ['pro', ...PRO_PLANS.map(p => p.id)];

/** The package for an id, or null. Legacy `pro` resolves to monthly. */
function resolvePlan(id) {
  const key = String(id || '').trim();
  if (!key || key === 'pro') return PRO_PLANS.find(p => p.id === DEFAULT_PLAN_ID);
  return PRO_PLANS.find(p => p.id === key) || null;
}

/**
 * What this package costs today, in naira.
 *
 * [isApp] keeps the mobile app's own monthly price working. It was split out so
 * changing the app's activation fee never silently moved the website's monthly
 * price, and an admin may still have a figure in that field — but it only ever
 * applied to the monthly package, so the longer ones ignore it.
 */
function planPrice(plan, fees = {}, { isApp = false } = {}) {
  if (isApp && plan.id === DEFAULT_PLAN_ID && Number(fees.appActivation) > 0) {
    return Math.round(Number(fees.appActivation));
  }
  const override = Number(fees[plan.feeKey]);
  return Math.round(Number.isFinite(override) && override > 0 ? override : plan.defaultPrice);
}

/** "Pro — 6 Months (182 days access)" — what the student and the admin both read. */
function planDescription(plan) {
  return `Pro — ${plan.label} (${plan.days} days access)`;
}

/** Default price for every package, keyed by its settings field. */
const PLAN_FEE_DEFAULTS = Object.fromEntries(
  PRO_PLANS.map(p => [p.feeKey, p.defaultPrice])
);

module.exports = {
  PRO_PLANS,
  PLAN_IDS,
  PLAN_FEE_DEFAULTS,
  DEFAULT_PLAN_ID,
  resolvePlan,
  planPrice,
  planDescription,
};
