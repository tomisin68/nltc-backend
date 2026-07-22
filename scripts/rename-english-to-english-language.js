// One-off script: rename subject 'English' -> 'English Language' in the questions collection
// (reverses the earlier normalize-subject-names.js remap, now that the app's canonical
// senior-subject name is 'English Language')
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { initFirebase, getDb } = require('../config/firebase');

async function main() {
  initFirebase();
  const db = getDb();

  const snap = await db.collection('questions').where('subject', '==', 'English').get();

  if (snap.empty) {
    console.log('No questions with subject "English" found — nothing to do.');
    return;
  }

  const chunks = [];
  for (let i = 0; i < snap.docs.length; i += 500) chunks.push(snap.docs.slice(i, i + 500));

  for (const chunk of chunks) {
    const batch = db.batch();
    chunk.forEach(d => batch.update(d.ref, { subject: 'English Language' }));
    await batch.commit();
  }

  console.log(`✅ ${snap.size} question(s) updated: "English" → "English Language".`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
