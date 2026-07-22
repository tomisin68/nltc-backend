// Find questions whose options contain long descriptive text (e.g. "X — description; Y — description")
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { initFirebase, getDb } = require('../config/firebase');

// Pattern: options that contain an em-dash (—) which indicates explanatory text smuggled into an option
const BAD_OPTION_PATTERN = /—/;

async function scanCollection(db, collectionName) {
  console.log(`\nScanning "${collectionName}"…`);
  const snap = await db.collection(collectionName).get();
  console.log(`  ${snap.size.toLocaleString()} documents loaded.`);

  const hits = [];

  snap.docs.forEach(doc => {
    const data = doc.data();
    const options = data.options || data.choices || [];

    if (!Array.isArray(options)) return;

    const badOptions = options.filter(opt => BAD_OPTION_PATTERN.test(String(opt)));
    if (badOptions.length > 0) {
      hits.push({
        id: doc.id,
        subject: data.subject || '—',
        question: (data.question || '').slice(0, 100),
        badOptions,
      });
    }
  });

  return { total: snap.size, hits };
}

async function main() {
  initFirebase();
  const db = getDb();

  for (const coll of ['questions', 'jssQuestions']) {
    const { total, hits } = await scanCollection(db, coll);

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`Collection: ${coll}   (${total.toLocaleString()} total)`);
    console.log(`Questions with em-dash options: ${hits.length.toLocaleString()}`);

    if (hits.length === 0) {
      console.log('  ✓ None found.');
      continue;
    }

    // Group by subject
    const bySubject = {};
    hits.forEach(h => {
      bySubject[h.subject] = (bySubject[h.subject] || 0) + 1;
    });

    console.log('\nBy subject:');
    Object.entries(bySubject)
      .sort((a, b) => b[1] - a[1])
      .forEach(([s, c]) => console.log(`  ${s.padEnd(32)} ${c}`));

    console.log('\nFull details:');
    console.log('─'.repeat(70));
    hits.forEach((h, i) => {
      console.log(`\n[${i + 1}] Doc ID : ${h.id}`);
      console.log(`    Subject: ${h.subject}`);
      console.log(`    Question: ${h.question}`);
      console.log(`    Bad option(s):`);
      h.badOptions.forEach(opt => console.log(`      • ${opt}`));
    });
    console.log('─'.repeat(70));
  }

  console.log('\nDone.');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
