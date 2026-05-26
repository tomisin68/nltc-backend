/**
 * backfill-legacy-fee-records.js
 *
 * For students with lessonFeePaid=true but no payment subcollection record:
 *   - Creates a synthetic "legacy_backfill" payment record (amount=0)
 *   - Does NOT touch lessonFeePaid, lessonFeeExpiresAt, or any other field
 *   - Does NOT set any expiry — legacy students remain grandfathered
 *
 * Safe to run multiple times (idempotent: skips students who already have records).
 *
 * Run: node scripts/backfill-legacy-fee-records.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { initFirebase, getDb } = require('../config/firebase');
const admin = require('firebase-admin');

async function main() {
  initFirebase();
  const db = getDb();

  console.log('\n=== Legacy Fee Record Backfill ===\n');
  console.log('Scanning physical students with lessonFeePaid=true...\n');

  const snap = await db.collection('users')
    .where('role', '==', 'student')
    .where('studentMode', '==', 'physical')
    .where('lessonFeePaid', '==', true)
    .get();

  console.log(`Found ${snap.size} physical students marked as paid.\n`);

  let skipped = 0;
  let created = 0;
  let errors  = 0;

  for (const d of snap.docs) {
    const s    = d.data();
    const uid  = d.id;
    const name = `${s.firstName || ''} ${s.lastName || ''}`.trim() || s.email;

    // Check if they already have a payment record
    const existingSnap = await db.collection('users').doc(uid)
      .collection('payments')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (!existingSnap.empty) {
      console.log(`  SKIP  ${name} — already has ${existingSnap.size}+ payment record(s)`);
      skipped++;
      continue;
    }

    // Create a synthetic legacy record
    const ref = `legacy_backfill_${uid}`;
    const paidAt = s.lessonFeePaidAt
      ? (s.lessonFeePaidAt.toDate ? s.lessonFeePaidAt.toDate() : new Date(s.lessonFeePaidAt))
      : new Date();
    const periodLabel = paidAt.toLocaleString('en-NG', { month: 'long', year: 'numeric' });

    try {
      await db.collection('users').doc(uid).collection('payments').doc(ref).set({
        uid,
        reference:   ref,
        type:        'lesson_fee',
        plan:        null,
        amount:      0,
        description: 'Legacy payment — recorded before monthly billing system',
        periodLabel,
        status:      'success',
        periodStart: admin.firestore.Timestamp.fromDate(new Date(paidAt.getFullYear(), paidAt.getMonth(), 1)),
        periodEnd:   null,   // no expiry — grandfathered
        createdAt:   s.lessonFeePaidAt || admin.firestore.FieldValue.serverTimestamp(),
        _backfilled: true,
      });
      console.log(`  CREATE ${name} — legacy record created (paid ~${periodLabel})`);
      created++;
    } catch (err) {
      console.error(`  ERROR  ${name}: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n─── Backfill Complete ───────────────────`);
  console.log(`  Skipped (already had records): ${skipped}`);
  console.log(`  Records created:               ${created}`);
  console.log(`  Errors:                        ${errors}`);
  console.log('\n✅ No existing payment records were modified.');
  console.log('   Legacy students retain their perpetual access (no expiry set).\n');
}

main().catch(err => { console.error('Backfill error:', err.message); process.exit(1); });
