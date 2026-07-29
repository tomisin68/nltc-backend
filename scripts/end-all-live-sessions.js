// Ops script: close down live classes that are still open.
//
//   node scripts/end-all-live-sessions.js              → ends everything on air now
//   node scripts/end-all-live-sessions.js --dry        → lists them, changes nothing
//   node scripts/end-all-live-sessions.js --scheduled  → also closes upcoming (scheduled) ones
//
// Scheduled sessions are left alone by default: they are classes that have not
// happened yet, and ending one silently cancels it on every student's timetable.
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const admin = require('firebase-admin');
const { initFirebase, getDb } = require('../config/firebase');

const DRY           = process.argv.includes('--dry');
const WITH_SCHEDULED = process.argv.includes('--scheduled');
const STATUSES      = WITH_SCHEDULED ? ['live', 'scheduled'] : ['live'];

function startedAt(s) {
  const d = s.startedAt?.toDate?.() || s.launchedAt?.toDate?.() || s.createdAt?.toDate?.();
  return d ? d.toISOString().slice(0, 16).replace('T', ' ') : '—';
}

async function main() {
  initFirebase();
  const db = getDb();

  const snap = await db.collection('liveSessions').where('status', 'in', STATUSES).get();

  if (snap.empty) {
    console.log(`No ${STATUSES.join(' or ')} sessions found — nothing to do.`);
    return;
  }

  snap.docs.forEach(d => {
    const s = d.data();
    console.log(
      `  [${s.status}] ${d.id}  ${(s.title || '(untitled)').slice(0, 44)}`
      + `  host=${s.hostName || '?'}  in-room=${Object.keys(s.viewers || {}).length}`
      + `  since=${startedAt(s)}`
    );
  });

  if (DRY) {
    console.log(`\n${snap.size} session(s) would be ended. Re-run without --dry to do it.`);
    return;
  }

  // The room state is cleared alongside the status: a session reopened later
  // starts empty rather than inheriting a stale headcount, presence map, pinned
  // tile or waiting room from the class that was cut off.
  const batch = db.batch();
  snap.docs.forEach(d => batch.update(d.ref, {
    status:      'ended',
    endedAt:     admin.firestore.FieldValue.serverTimestamp(),
    viewerCount: 0,
    viewers:     {},
    agoraMap:    {},
    raisedHands: {},
    typing:      {},
    featuredUid: null,
  }));

  await batch.commit();
  console.log(`\n✅ ${snap.size} session(s) ended.`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
