/**
 * audit-lesson-fees.js
 * Read-only audit of lesson fee payment state across all students.
 * Does NOT modify any data.
 *
 * Run: node scripts/audit-lesson-fees.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { initFirebase, getDb } = require('../config/firebase');

async function main() {
  initFirebase();
  const db = getDb();

  console.log('\n=== NLTC Lesson Fee Audit ===\n');

  // Load all students, centers
  const [usersSnap, centersSnap] = await Promise.all([
    db.collection('users').where('role', '==', 'student').get(),
    db.collection('centers').get(),
  ]);

  const centerMap = {};
  centersSnap.forEach(d => { centerMap[d.id] = d.data().name || d.id; });

  const now = Date.now();

  const students = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const physical = students.filter(s => s.studentMode === 'physical');
  const online   = students.filter(s => s.studentMode !== 'physical');

  console.log(`Total students:    ${students.length}`);
  console.log(`  Physical:        ${physical.length}`);
  console.log(`  Online:          ${online.length}\n`);

  // Per-student checks
  let paidFlag        = 0;
  let unpaidFlag      = 0;
  let withExpiry      = 0;
  let noExpiry        = 0;
  let expiredStillSet = 0;   // lessonFeePaid=true but expiry in past
  let missingRecord   = 0;   // lessonFeePaid=true but no payment subcollection doc
  let orphanRecords   = 0;   // has payment records but lessonFeePaid=false

  const issues = [];

  for (const s of physical) {
    const name  = `${s.firstName || ''} ${s.lastName || ''}`.trim() || s.email;
    const center = centerMap[s.center] || s.center || '(no center)';

    // Load payment subcollection (no compound filter to avoid index requirement)
    const paySnap = await db.collection('users').doc(s.id)
      .collection('payments')
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();

    const payDocs = paySnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(p => p.type === 'lesson_fee');

    if (s.lessonFeePaid) {
      paidFlag++;

      // Check expiry
      const expTs = s.lessonFeeExpiresAt;
      const expMs = expTs?.toMillis?.() || (expTs?._seconds ? expTs._seconds * 1000 : null) || (expTs?.seconds ? expTs.seconds * 1000 : null);

      if (expMs) {
        withExpiry++;
        if (expMs < now) {
          expiredStillSet++;
          issues.push({
            type: 'EXPIRED_BUT_FLAGGED',
            uid: s.id, name, center,
            detail: `lessonFeePaid=true but expired on ${new Date(expMs).toLocaleDateString('en-NG')}`,
          });
        }
      } else {
        noExpiry++;
        issues.push({
          type: 'PAID_NO_EXPIRY',
          uid: s.id, name, center,
          detail: 'lessonFeePaid=true but no lessonFeeExpiresAt set (legacy record)',
        });
      }

      // Check for payment record
      if (payDocs.length === 0) {
        missingRecord++;
        issues.push({
          type: 'PAID_NO_RECORD',
          uid: s.id, name, center,
          detail: 'lessonFeePaid=true but no payment record in subcollection',
        });
      }
    } else {
      unpaidFlag++;

      // Check for orphan payment records (paid record exists but flag is false)
      const successPays = payDocs.filter(p => p.status === 'success');
      if (successPays.length > 0) {
        const latest = successPays[0];
        const endMs  = latest.periodEnd?.toMillis?.() || (latest.periodEnd?._seconds ? latest.periodEnd._seconds * 1000 : null);
        if (endMs && endMs > now) {
          orphanRecords++;
          issues.push({
            type: 'ORPHAN_RECORD',
            uid: s.id, name, center,
            detail: `Has active payment record (ref: ${latest.reference}) but lessonFeePaid=false`,
          });
        }
      }
    }
  }

  // Summary
  console.log('─── Physical Student Fee Summary ─────────────────────────');
  console.log(`  Marked paid (lessonFeePaid=true):   ${paidFlag}`);
  console.log(`    - With valid expiry date:          ${withExpiry - expiredStillSet}`);
  console.log(`    - With no expiry set (legacy):     ${noExpiry}`);
  console.log(`    - Expired but still flagged paid:  ${expiredStillSet}`);
  console.log(`    - Missing payment record:          ${missingRecord}`);
  console.log(`  Marked unpaid (lessonFeePaid=false): ${unpaidFlag}`);
  console.log(`    - With orphaned active record:     ${orphanRecords}`);
  console.log('──────────────────────────────────────────────────────────\n');

  // By center
  const byCenterData = {};
  for (const s of physical) {
    const cid  = s.center || '__none__';
    const cname = centerMap[cid] || '(no center)';
    if (!byCenterData[cid]) byCenterData[cid] = { name: cname, total: 0, paid: 0, expired: 0, unpaid: 0 };
    const rec = byCenterData[cid];
    rec.total++;
    if (s.lessonFeePaid) {
      const expTs = s.lessonFeeExpiresAt;
      const expMs = expTs?.toMillis?.() || (expTs?._seconds ? expTs._seconds * 1000 : null) || (expTs?.seconds ? expTs.seconds * 1000 : null);
      if (expMs && expMs < now) { rec.expired++; }
      else { rec.paid++; }
    } else { rec.unpaid++; }
  }

  console.log('─── By Center ────────────────────────────────────────────');
  const fmt = (n, w) => String(n).padStart(w);
  console.log('Center'.padEnd(30) + 'Total  Paid  Expired  Unpaid');
  console.log('─'.repeat(60));
  Object.values(byCenterData).sort((a,b) => b.total - a.total).forEach(c => {
    console.log(
      c.name.slice(0,28).padEnd(30) +
      fmt(c.total, 5) + '  ' + fmt(c.paid, 4) + '  ' +
      fmt(c.expired, 7) + '  ' + fmt(c.unpaid, 6)
    );
  });
  console.log('─'.repeat(60));

  // Issues
  if (issues.length === 0) {
    console.log('\n✅ No data inconsistencies found. All fee records are aligned.\n');
  } else {
    console.log(`\n⚠️  ${issues.length} issue(s) found (READ-ONLY — no data modified):\n`);
    const byType = {};
    issues.forEach(i => { if (!byType[i.type]) byType[i.type] = []; byType[i.type].push(i); });
    Object.entries(byType).forEach(([type, list]) => {
      console.log(`  [${type}] — ${list.length} occurrence(s)`);
      list.slice(0, 5).forEach(i => console.log(`    • ${i.name} (${i.center}): ${i.detail}`));
      if (list.length > 5) console.log(`    ... and ${list.length - 5} more`);
      console.log();
    });
    console.log('  Note: EXPIRED_BUT_FLAGGED records will be auto-corrected by the');
    console.log('  AuthContext expiry check when students next log in.');
    console.log('  PAID_NO_EXPIRY records are legacy (paid before monthly system)');
    console.log('  and are intentionally grandfathered — no action needed.\n');
  }
}

main().catch(err => { console.error('Audit error:', err.message); process.exit(1); });
