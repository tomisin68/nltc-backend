// Count questions by subject — verify English and all other subject counts
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { initFirebase, getDb } = require('../config/firebase');

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
  console.log(`  → Landing page shows:      ${(Math.floor(total / 100) * 100).toLocaleString()}+\n`);

  const sorted = Object.entries(bySubject).sort((a, b) => b[1] - a[1]);
  const col1 = 34, col2 = 8, col3 = 22;
  const line = '─'.repeat(col1 + col2 + col3);

  console.log('Questions by subject:');
  console.log(line);
  console.log('Subject'.padEnd(col1) + 'Total'.padStart(col2) + '  With Explanation'.padStart(col3));
  console.log(line);

  sorted.forEach(([s, c]) => {
    const e = withExpl[s] || 0;
    const pct = c > 0 ? Math.round((e / c) * 100) : 0;
    console.log(
      s.slice(0, col1 - 2).padEnd(col1) +
      c.toString().padStart(col2) +
      `  ${e} (${pct}%)`.padStart(col3)
    );
  });

  console.log(line);
  const totalExpl = Object.values(withExpl).reduce((a, b) => a + b, 0);
  console.log(`\nTOTAL: ${total.toLocaleString()} questions  |  ${totalExpl.toLocaleString()} with explanations (${Math.round((totalExpl/total)*100)}%)`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
