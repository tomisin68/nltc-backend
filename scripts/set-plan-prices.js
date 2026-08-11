/**
 * set-plan-prices.js
 * Writes the Pro package prices into settings/fees.
 *
 * The catalogue in src/config/plans.js carries defaults, but a stored value
 * always wins — that is the point of the settings document, and it means the
 * live site keeps charging whatever an admin last set even after a deploy that
 * changes the defaults. `settings/fees` still holds a single `proMonthly` from
 * before the quarterly, 6-month and yearly packages existed, so run this once
 * to bring it in line.
 *
 * Dry run (default — reports without writing):
 *   node scripts/set-plan-prices.js
 * Apply:
 *   node scripts/set-plan-prices.js --apply
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { initFirebase, getDb } = require('../config/firebase');
const { PRO_PLANS }           = require('../src/config/plans');

const APPLY = process.argv.includes('--apply');

const naira = n => `₦${Number(n).toLocaleString('en-NG')}`;

async function main() {
  initFirebase();
  const db = getDb();

  console.log(`\n=== Pro package prices (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);

  const snap    = await db.collection('settings').doc('fees').get();
  const current = snap.exists ? snap.data() : {};

  const updates = {};
  for (const plan of PRO_PLANS) {
    const now = current[plan.feeKey];
    const next = plan.defaultPrice;
    const same = Number(now) === next;
    console.log(
      `  ${`Pro (${plan.label})`.padEnd(20)} ${String(plan.days + 'd').padEnd(6)} ` +
      `${(now == null ? 'unset' : naira(now)).padStart(10)} → ${naira(next).padStart(10)}` +
      `${same ? '   (unchanged)' : ''}`
    );
    if (!same) updates[plan.feeKey] = next;
  }

  if (!Object.keys(updates).length) {
    console.log('\nEvery package already carries its catalogue price — nothing to write.\n');
    return;
  }

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to store these prices.\n');
    return;
  }

  await db.collection('settings').doc('fees').set(updates, { merge: true });
  console.log(`\nDone — ${Object.keys(updates).length} price(s) written to settings/fees.`);
  console.log('The backend caches fees for 5 minutes, so the new figures appear shortly.\n');
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('Failed:', err); process.exit(1); });
