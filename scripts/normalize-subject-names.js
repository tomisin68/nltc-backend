// Normalize subject names so they match the exact names used in CBTPage SUBJECTS_CONFIG
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { initFirebase, getDb } = require('../config/firebase');

// Map: stored value → canonical value used by the app
const REMAP = {
  'ENGLISH':                    'English',
  'English Language':           'English',
  'ECONOMICS':                  'Economics',
  'CURRENT AFFAIRS':            'Current Affairs',
  'ACCOUNTING':                 'Accounting',
  'Islamic Religious Studies':  'IRS',
};

async function main() {
  initFirebase();
  const db = getDb();

  let totalUpdated = 0;

  for (const [from, to] of Object.entries(REMAP)) {
    process.stdout.write(`  "${from}" → "${to}" … `);
    const snap = await db.collection('questions').where('subject', '==', from).get();
    if (snap.empty) { console.log('0 documents (skip)'); continue; }

    // Firestore batch max 500 writes
    const chunks = [];
    for (let i = 0; i < snap.docs.length; i += 500) chunks.push(snap.docs.slice(i, i + 500));

    for (const chunk of chunks) {
      const batch = db.batch();
      chunk.forEach(d => batch.update(d.ref, { subject: to }));
      await batch.commit();
    }

    console.log(`${snap.size} updated ✓`);
    totalUpdated += snap.size;
  }

  console.log(`\n✅ Done — ${totalUpdated} documents updated.`);
  console.log('Run count-questions.js to verify the new counts.\n');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
