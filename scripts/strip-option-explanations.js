// Strip explanatory text after em-dash from question options (a, b, c, d)
// e.g. "Automatic retailing — machines that dispense..." → "Automatic retailing"
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { initFirebase, getDb } = require('../config/firebase');

const EM_DASH = /\s*—\s*/;
const OPTION_KEYS = ['a', 'b', 'c', 'd'];

function stripExplanation(text) {
  if (!text || !EM_DASH.test(text)) return null; // null = no change needed
  return text.split(/\s*—\s*/)[0].trim();
}

async function processCollection(db, collectionName, dryRun) {
  console.log(`\nScanning "${collectionName}"…`);
  const snap = await db.collection(collectionName).get();
  console.log(`  ${snap.size.toLocaleString()} documents loaded.`);

  const updates = []; // { ref, changes: { a?: newVal, b?: newVal, … } }

  snap.docs.forEach(doc => {
    const data = doc.data();
    const changes = {};

    OPTION_KEYS.forEach(k => {
      const stripped = stripExplanation(String(data[k] || ''));
      if (stripped !== null) changes[k] = stripped;
    });

    if (Object.keys(changes).length > 0) {
      updates.push({ ref: doc.ref, changes });
    }
  });

  console.log(`  ${updates.length} documents need updating.`);

  if (dryRun) {
    console.log('\n  DRY RUN — first 10 changes:');
    updates.slice(0, 10).forEach(u => {
      const data = snap.docs.find(d => d.ref.path === u.ref.path).data();
      Object.entries(u.changes).forEach(([k, newVal]) => {
        console.log(`    [${u.ref.id}] (${k})`);
        console.log(`      Before: ${data[k]}`);
        console.log(`      After : ${newVal}`);
      });
    });
    return updates.length;
  }

  // Batch write in chunks of 400
  const BATCH_SIZE = 400;
  let updated = 0;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const chunk = updates.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    chunk.forEach(({ ref, changes }) => batch.update(ref, changes));
    await batch.commit();
    updated += chunk.length;
    process.stdout.write(`  Updated ${updated}/${updates.length}\r`);
  }
  console.log(`\n  ✓ ${updated} documents updated in "${collectionName}".`);
  return updated;
}

async function main() {
  const dryRun = !process.argv.includes('--apply');

  if (dryRun) {
    console.log('DRY RUN mode — pass --apply to write changes to Firestore.\n');
  } else {
    console.log('APPLY mode — writing changes to Firestore.\n');
  }

  initFirebase();
  const db = getDb();

  let total = 0;
  for (const coll of ['questions', 'jssQuestions']) {
    total += await processCollection(db, coll, dryRun);
  }

  console.log(`\nTotal documents to update: ${total}`);
  if (dryRun) console.log('Re-run with --apply to commit these changes.');
  else console.log('Done.');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
