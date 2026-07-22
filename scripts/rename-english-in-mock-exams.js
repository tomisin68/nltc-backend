// One-off script: rename subject 'English' -> 'English Language' inside mockExams.subjects[]
// The `questions` collection stores subject as 'English Language'; any mock exam whose
// subjects array still says 'English' fetches zero questions for that subject.
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { initFirebase, getDb } = require('../config/firebase');

async function main() {
  initFirebase();
  const db = getDb();

  const snap = await db.collection('mockExams').get();
  let updated = 0;

  for (const d of snap.docs) {
    const data = d.data();
    const subjects = data.subjects || [];
    if (!subjects.some(s => s.subject === 'English')) continue;

    const newSubjects = subjects.map(s => s.subject === 'English' ? { ...s, subject: 'English Language' } : s);
    await d.ref.update({ subjects: newSubjects });
    console.log(`  Updated: ${data.title || d.id}`);
    updated++;
  }

  console.log(`\n✅ ${updated} mock exam(s) updated.`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
