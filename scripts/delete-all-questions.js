// Delete every document in the 'questions' collection (the CBT question bank).
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { initFirebase, getDb } = require('../config/firebase');

async function main() {
  initFirebase();
  const db = getDb();

  console.log('Fetching all questions from Firestore...');
  const snap = await db.collection('questions').get();
  const total = snap.size;

  if (total === 0) {
    console.log('Collection "questions" is already empty.');
    return;
  }

  console.log(`Deleting ${total.toLocaleString()} question(s)...`);

  let deleted = 0;
  const batchSize = 400;
  const docs = snap.docs;

  for (let i = 0; i < docs.length; i += batchSize) {
    const chunk = docs.slice(i, i + batchSize);
    const batch = db.batch();
    chunk.forEach(d => batch.delete(d.ref));
    await batch.commit();
    deleted += chunk.length;
    process.stdout.write(`  deleted ${deleted}/${total}\r`);
  }

  console.log(`\nDone. ${deleted.toLocaleString()} question(s) deleted from "questions".`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
