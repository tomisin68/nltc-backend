// Daily access-expiry sweep — runs every day at 01:15 UTC (02:15 WAT).
//
// The frontend already refuses to render paid views once a grant lapses, but
// until the Firestore document itself is updated the admin lists, the revenue
// report and every backend read still see the student as "pro / fee paid".
// This job makes the database agree with reality:
//
//   lessonFeeExpiresAt in the past  → lessonFeePaid: false
//   planExpiresAt      in the past  → plan: 'free'
//
// Mirrors the client rule in NLTC Online/src/utils/access.js — keep them in step.
const cron  = require('node-cron');
const admin = require('firebase-admin');
const { getDb } = require('../../config/firebase');
const logger    = require('../utils/logger');

const BATCH_LIMIT = 400; // Firestore caps a write batch at 500

function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate();
  const d = new Date(ts);
  return isNaN(d) ? null : d;
}

async function commitAll(batches) {
  for (const batch of batches) await batch.commit();
}

async function runAccessExpiry(now = new Date()) {
  const db = getDb();
  logger.info('Access expiry job started', { date: now.toISOString() });

  let lessonExpired = 0, planExpired = 0, errors = 0;

  try {
    // Range queries on a single field are covered by the automatic index, so no
    // composite index is needed — the paid flag is checked in memory.
    const [lessonSnap, planSnap] = await Promise.all([
      db.collection('users').where('lessonFeeExpiresAt', '<=', now).get(),
      db.collection('users').where('planExpiresAt',      '<=', now).get(),
    ]);

    const patches = new Map(); // uid → { ref, data }
    const stage = (docSnap, data) => {
      const existing = patches.get(docSnap.id);
      if (existing) Object.assign(existing.data, data);
      else patches.set(docSnap.id, { ref: docSnap.ref, data: { ...data } });
    };

    for (const d of lessonSnap.docs) {
      const u = d.data();
      if (u.lessonFeePaid !== true) continue;      // already cleared
      const exp = toDate(u.lessonFeeExpiresAt);
      if (!exp || exp > now) continue;
      stage(d, { lessonFeePaid: false, lessonFeeExpiredAt: admin.firestore.Timestamp.fromDate(exp) });
      lessonExpired++;

      // Manual activations used to write `plan: 'pro'` with no planExpiresAt.
      // Left alone, that undated grant outlives the fee it came from — clear it
      // alongside the fee so the document reflects real access.
      if (u.plan && u.plan !== 'free' && !u.planExpiresAt) {
        stage(d, { plan: 'free', planExpiredAt: admin.firestore.Timestamp.fromDate(exp) });
        planExpired++;
      }
    }

    for (const d of planSnap.docs) {
      const u = d.data();
      if (!u.plan || u.plan === 'free') continue;  // already downgraded
      const exp = toDate(u.planExpiresAt);
      if (!exp || exp > now) continue;
      stage(d, { plan: 'free', planExpiredAt: admin.firestore.Timestamp.fromDate(exp) });
      planExpired++;
    }

    const entries = [...patches.values()];
    const batches = [];
    for (let i = 0; i < entries.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      for (const { ref, data } of entries.slice(i, i + BATCH_LIMIT)) {
        batch.update(ref, { ...data, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
      batches.push(batch);
    }
    await commitAll(batches);

    logger.info('Access expiry job finished', {
      lessonExpired, planExpired, accountsTouched: entries.length,
    });
  } catch (err) {
    errors++;
    logger.error('Access expiry job failed', { err: err.message });
  }

  return { lessonExpired, planExpired, errors };
}

function startAccessExpiryJob() {
  // Every day at 01:15 UTC (02:15 WAT) — quiet hours, before the morning reports
  cron.schedule('15 1 * * *', () => {
    runAccessExpiry().catch(err =>
      logger.error('Access expiry job unhandled error', { err: err.message })
    );
  }, { timezone: 'UTC' });

  logger.info('Access expiry job scheduled (daily 01:15 UTC)');
}

module.exports = { startAccessExpiryJob, runAccessExpiry };
