/**
 * migrate-elite-to-pro.js
 *
 * The Elite plan has been removed from the platform. This migrates any
 * remaining references to it so existing paid users/content don't silently
 * fall out of every plan-gated check:
 *
 *   - users.plan === 'elite'   → 'pro'
 *   - videos.access === 'elite' → 'pro'
 *
 * Dry-run by default — prints what WOULD change without writing anything.
 * Pass --apply to actually commit the updates.
 *
 * Run: node scripts/migrate-elite-to-pro.js          (dry run)
 *      node scripts/migrate-elite-to-pro.js --apply   (writes changes)
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { initFirebase, getDb } = require('../config/firebase');

const APPLY = process.argv.includes('--apply');

async function migrateCollection(db, collectionName, field) {
  const snap = await db.collection(collectionName).where(field, '==', 'elite').get();

  if (snap.empty) {
    console.log(`  ${collectionName}.${field}: 0 documents with 'elite' (nothing to do)`);
    return 0;
  }

  console.log(`  ${collectionName}.${field}: ${snap.size} document(s) with 'elite'`);
  snap.docs.forEach(d => console.log(`    - ${d.id}`));

  if (!APPLY) return snap.size;

  // Firestore batch max 500 writes
  const chunks = [];
  for (let i = 0; i < snap.docs.length; i += 500) chunks.push(snap.docs.slice(i, i + 500));

  for (const chunk of chunks) {
    const batch = db.batch();
    chunk.forEach(d => batch.update(d.ref, { [field]: 'pro' }));
    await batch.commit();
  }

  console.log(`    ✓ updated ${snap.size} document(s) → 'pro'`);
  return snap.size;
}

async function main() {
  initFirebase();
  const db = getDb();

  console.log(`\n=== Elite → Pro Migration ${APPLY ? '(APPLYING CHANGES)' : '(DRY RUN — pass --apply to write)'} ===\n`);

  const usersChanged  = await migrateCollection(db, 'users', 'plan');
  const videosChanged = await migrateCollection(db, 'videos', 'access');

  console.log(`\n─── Summary ───────────────────────────────`);
  console.log(`  Users${APPLY ? ' updated' : ' to update'}:  ${usersChanged}`);
  console.log(`  Videos${APPLY ? ' updated' : ' to update'}: ${videosChanged}`);
  if (!APPLY) console.log('\nNo changes written. Re-run with --apply to commit.\n');
  else console.log('\n✅ Migration complete.\n');
}

main().catch(err => { console.error('Migration error:', err.message); process.exit(1); });
