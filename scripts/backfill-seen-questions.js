// Backfill users/{uid}/ml/profile.seenQuestions from historical interactionBatches.
// The Subject Coverage card on the student dashboard reads this map; until
// 2026-07 nothing wrote it (the nltc-ml service was never deployed), so this
// script replays every logged answer batch into the per-user seen-question map.
//
// Safe to re-run: it rebuilds the map from scratch each time (counts are
// recomputed from all batches, not incremented on top of existing values).
//
// Usage: node scripts/backfill-seen-questions.js
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { initFirebase, getDb } = require('../config/firebase');

async function main() {
  initFirebase();
  const db = getDb();

  console.log('Fetching all interactionBatches...\n');
  const snap = await db.collection('interactionBatches').get();
  console.log(`${snap.size} batches found`);

  // uid → { questionId → { seenCount, lastSeenAt } }
  const byUser = {};
  snap.docs.forEach(d => {
    const { uid, answers, submittedAt } = d.data();
    if (!uid || !Array.isArray(answers)) return;
    const seenAt = submittedAt?.toDate?.() || new Date(0);
    const map = (byUser[uid] = byUser[uid] || {});
    answers.forEach(a => {
      if (!a?.questionId) return;
      const entry = (map[a.questionId] = map[a.questionId] || { seenCount: 0, lastSeenAt: seenAt });
      entry.seenCount += 1;
      if (seenAt > entry.lastSeenAt) entry.lastSeenAt = seenAt;
    });
  });

  const uids = Object.keys(byUser);
  console.log(`${uids.length} students have logged answers\n`);

  let done = 0;
  for (const uid of uids) {
    const seenQuestions = byUser[uid];
    await db.collection('users').doc(uid).collection('ml').doc('profile').set({
      seenQuestions,
      seenUpdatedAt: new Date(),
    }, { merge: true });
    done++;
    const qCount = Object.keys(seenQuestions).length;
    console.log(`  [${done}/${uids.length}] ${uid} — ${qCount} distinct questions`);
  }

  console.log(`\nDone. Backfilled seenQuestions for ${done} students.`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
