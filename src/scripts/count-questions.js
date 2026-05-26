// Count questions by subject and show which have explanations (used by Study Mode)
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });
const { initFirebase, getDb } = require('../../config/firebase');

async function main() {
  initFirebase();
  const db = getDb();

  console.log('Fetching all questions from Firestore...\n');
  const snap = await db.collection('questions').get();
  const total = snap.size;

  const bySubject = {};
  const withExpl  = {};

  snap.docs.forEach(d => {
    const { subject, explanation, solution } = d.data();
    const s = (subject || 'Unknown').trim();
    bySubject[s] = (bySubject[s] || 0) + 1;
    if ((explanation || solution || '').trim()) {
      withExpl[s] = (withExpl[s] || 0) + 1;
    }
  });

  console.log(`TOTAL questions in database: ${total.toLocaleString()}`);
  console.log(`  → Shown on landing page as: ${(Math.floor(total / 100) * 100).toLocaleString()}+\n`);

  console.log('Questions by subject (sorted by count):');
  console.log('─'.repeat(60));
  console.log('Subject'.padEnd(32) + 'Total'.padStart(8) + '  With Explanation'.padStart(20));
  console.log('─'.repeat(60));

  Object.entries(bySubject)
    .sort((a, b) => b[1] - a[1])
    .forEach(([s, c]) => {
      const e = withExpl[s] || 0;
      const pct = c > 0 ? Math.round((e / c) * 100) : 0;
      console.log(
        s.slice(0, 30).padEnd(32) +
        c.toString().padStart(8) +
        `  ${e} (${pct}%)`.padStart(20)
      );
    });

  console.log('─'.repeat(60));
  console.log('\nDone.');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
