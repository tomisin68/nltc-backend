// One-off script: set all live/scheduled liveSessions to ended
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { initFirebase, getDb } = require('../config/firebase');

async function main() {
  initFirebase();
  const db = getDb();

  const snap = await db.collection('liveSessions')
    .where('status', 'in', ['live', 'scheduled'])
    .get();

  if (snap.empty) {
    console.log('No live or scheduled sessions found — nothing to do.');
    return;
  }

  const batch = db.batch();
  snap.docs.forEach(d => {
    console.log(`  Ending: [${d.data().status}] ${d.data().title || d.id}`);
    batch.update(d.ref, { status: 'ended', viewerCount: 0, endedAt: new Date() });
  });

  await batch.commit();
  console.log(`\n✅ ${snap.size} session(s) ended.`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
