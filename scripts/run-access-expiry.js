/**
 * run-access-expiry.js
 * Runs the daily access-expiry sweep once, on demand.
 *
 * Existing accounts have been sitting with a lapsed lessonFeeExpiresAt while
 * still carrying `plan: 'pro'`, so they never locked. Run this once after
 * deploying to bring the database in line; the cron job keeps it there.
 *
 * Dry run (default — reports without writing):
 *   node scripts/run-access-expiry.js
 * Apply:
 *   node scripts/run-access-expiry.js --apply
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { initFirebase, getDb } = require('../config/firebase');
const { runAccessExpiry }     = require('../src/jobs/accessExpiry');

const APPLY = process.argv.includes('--apply');

function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate();
  const d = new Date(ts);
  return isNaN(d) ? null : d;
}

async function main() {
  initFirebase();
  const db  = getDb();
  const now = new Date();

  console.log(`\n=== Access Expiry Sweep (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);

  const snap = await db.collection('users').get();
  const stale = [];

  snap.forEach(d => {
    const u = d.data();
    const lessonExp = toDate(u.lessonFeeExpiresAt);
    const planExp   = toDate(u.planExpiresAt);
    const lessonStale = u.lessonFeePaid === true && lessonExp && lessonExp <= now;
    const planStale   = u.plan && u.plan !== 'free' && planExp && planExp <= now;
    // Undated 'pro' left behind by a manual activation whose fee has lapsed
    const orphanPlan  = u.plan && u.plan !== 'free' && !planExp && lessonExp && lessonExp <= now;
    if (lessonStale || planStale || orphanPlan) {
      stale.push({
        uid: d.id,
        email: u.email || '—',
        mode: u.studentMode || 'online',
        lessonExp: lessonExp ? lessonExp.toISOString().slice(0, 10) : '—',
        planExp: planExp ? planExp.toISOString().slice(0, 10) : (orphanPlan ? 'none (orphan)' : '—'),
      });
    }
  });

  if (!stale.length) {
    console.log('Nothing to expire — every account is in sync.\n');
    return;
  }

  console.log(`${stale.length} account(s) with lapsed access still marked active:\n`);
  for (const s of stale) {
    console.log(`  ${s.email.padEnd(34)} ${s.mode.padEnd(9)} fee:${s.lessonExp.padEnd(14)} plan:${s.planExp}`);
  }

  const orphans = stale.filter(s => s.planExp === 'none (orphan)');
  if (orphans.length) {
    console.log(`\n  ${orphans.length} of these carry an undated 'pro' plan — the reason they never locked.`);
    console.log('  The sweep clears both the fee flag and that orphaned plan.');
  }

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to update these accounts.\n');
    return;
  }

  const result = await runAccessExpiry(now);
  console.log(`\nDone — lesson fees cleared: ${result.lessonExpired}, plans downgraded: ${result.planExpired}, errors: ${result.errors}\n`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('Failed:', err); process.exit(1); });
