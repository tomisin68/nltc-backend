// Find duplicate questions across both 'questions' and 'jssQuestions' collections
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { initFirebase, getDb } = require('../config/firebase');

function normalize(text) {
  return (text || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

async function findDuplicates(db, collectionName) {
  console.log(`\nFetching ${collectionName}…`);
  const snap = await db.collection(collectionName).get();
  console.log(`  ${snap.size.toLocaleString()} documents loaded.`);

  const seen = {};     // normalized question text → first doc id
  const dupes = [];    // { id, subject, question, duplicateOf }

  snap.docs.forEach(d => {
    const data = d.data();
    const key  = normalize(data.question);
    if (!key) return;

    if (seen[key]) {
      dupes.push({
        id:          d.id,
        subject:     data.subject || '—',
        question:    (data.question || '').slice(0, 90),
        duplicateOf: seen[key],
      });
    } else {
      seen[key] = d.id;
    }
  });

  return { total: snap.size, dupes };
}

async function main() {
  initFirebase();
  const db = getDb();

  const col1 = 36, col2 = 18, col3 = 24;
  const sep  = '─'.repeat(col1 + col2 + col3 + 4);

  for (const coll of ['questions', 'jssQuestions']) {
    const { total, dupes } = await findDuplicates(db, coll);

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`Collection: ${coll}   (${total.toLocaleString()} total)`);
    console.log(`Duplicates found: ${dupes.length.toLocaleString()}`);

    if (dupes.length === 0) {
      console.log('  ✓ No duplicates — database is clean.');
      continue;
    }

    // Group by subject
    const bySubject = {};
    dupes.forEach(d => {
      bySubject[d.subject] = (bySubject[d.subject] || 0) + 1;
    });

    console.log('\nDuplicates by subject:');
    Object.entries(bySubject)
      .sort((a, b) => b[1] - a[1])
      .forEach(([s, c]) => console.log(`  ${s.padEnd(30)} ${c}`));

    console.log(`\n${sep}`);
    console.log(
      'Question (truncated)'.padEnd(col1) + '  ' +
      'Subject'.padEnd(col2) + '  ' +
      'Duplicate Doc ID'.padEnd(col3)
    );
    console.log(sep);

    dupes.forEach(d => {
      console.log(
        d.question.slice(0, col1).padEnd(col1) + '  ' +
        d.subject.slice(0, col2).padEnd(col2) + '  ' +
        d.id.slice(0, col3).padEnd(col3)
      );
    });

    console.log(sep);
    console.log(`\n${dupes.length} duplicate document(s) in "${coll}".`);
    console.log(`Run with --delete flag to remove them: node scripts/find-duplicate-questions.js --delete`);
  }

  // Delete mode
  if (process.argv.includes('--delete')) {
    console.log('\n⚠  DELETE MODE — removing duplicates…');
    for (const coll of ['questions', 'jssQuestions']) {
      const { dupes } = await findDuplicates(db, coll);
      if (!dupes.length) continue;

      let deleted = 0;
      const batchSize = 400;
      for (let i = 0; i < dupes.length; i += batchSize) {
        const chunk = dupes.slice(i, i + batchSize);
        const batch = db.batch();
        chunk.forEach(d => batch.delete(db.collection(coll).doc(d.id)));
        await batch.commit();
        deleted += chunk.length;
        process.stdout.write(`  ${coll}: deleted ${deleted}/${dupes.length}\r`);
      }
      console.log(`\n  ✓ ${deleted} duplicates removed from "${coll}".`);
    }
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
