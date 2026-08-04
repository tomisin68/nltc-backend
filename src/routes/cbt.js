const express        = require('express');
const admin          = require('firebase-admin');
const axios          = require('axios');
const { body }       = require('express-validator');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate }   = require('../middleware/validate');
const asyncHandler   = require('../utils/asyncHandler');
const logger         = require('../utils/logger');
const { getDb }      = require('../../config/firebase');

const router = express.Router();

// ─── GET /api/cbt/questions ──────────────────────────────────────────────────
// Returns questions WITHOUT correctAnswer. Supports filtering + shuffle.
router.get('/questions', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  let { subject, exam, limit = 40, year, shuffle = 'true' } = req.query;
  limit = Math.min(parseInt(limit) || 40, 100);

  let q = db.collection('questions').where('flagged', '==', false);
  if (subject) q = q.where('subject',  '==', subject);
  if (exam)    q = q.where('examType', '==', exam);
  if (year)    q = q.where('year',     '==', parseInt(year));

  // Over-fetch so shuffle has enough items to pick from
  const snap = await q.limit(limit * 3).get();

  let docs = snap.docs.map(d => ({
    id:       d.id,
    question: d.data().question,
    options:  d.data().options,
    subject:  d.data().subject,
    examType: d.data().examType,
    year:     d.data().year,
    // correctAnswer deliberately excluded
  }));

  if (shuffle === 'true') {
    docs = docs.sort(() => Math.random() - 0.5);
  }
  docs = docs.slice(0, limit);

  res.json({ questions: docs, total: docs.length, subject: subject || null, exam: exam || null });
}));

// ─── POST /api/cbt/submit ────────────────────────────────────────────────────
// Grades a CBT attempt server-side, saves result, awards XP.
router.post('/submit', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const { subject, exam, timeTaken, answers } = req.body;

  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return res.status(400).json({ error: 'answers must be an object mapping questionId → chosen option' });
  }

  const qIds = Object.keys(answers);
  if (!qIds.length) {
    return res.status(400).json({ error: 'answers cannot be empty' });
  }

  // Fetch correct answers from Firestore in batches of 10
  const correctMap     = {};
  const explanationMap = {};

  for (let i = 0; i < qIds.length; i += 10) {
    const batch  = qIds.slice(i, i + 10);
    const snaps  = await Promise.all(batch.map(id => db.collection('questions').doc(id).get()));
    snaps.forEach(s => {
      if (s.exists) {
        correctMap[s.id]     = s.data().correctAnswer;
        explanationMap[s.id] = s.data().explanation || '';
      }
    });
  }

  // Grade
  let correct = 0;
  const breakdown = qIds.map(id => {
    const isCorrect = answers[id] === correctMap[id];
    if (isCorrect) correct++;
    return {
      questionId:    id,
      yourAnswer:    answers[id],
      correctAnswer: correctMap[id],
      isCorrect,
      explanation:   explanationMap[id],
    };
  });

  const total    = qIds.length;
  const score    = total > 0 ? Math.round((correct / total) * 100 * 10) / 10 : 0;
  const xpEarned = Math.round(score * 0.5) + (score >= 70 ? 20 : 0);

  // Save result to users/{uid}/results subcollection
  const resultRef = await db
    .collection('users').doc(req.user.uid)
    .collection('results').add({
      subject:     subject     || null,
      exam:        exam        || null,
      score,
      correct,
      total,
      timeTaken:   timeTaken   || 0,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

  // Update aggregate stats on the user document
  await db.collection('users').doc(req.user.uid).update({
    xp:           admin.firestore.FieldValue.increment(xpEarned),
    cbtCount:     admin.firestore.FieldValue.increment(1),
    totalCorrect: admin.firestore.FieldValue.increment(correct),
    updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
  });

  logger.info('CBT submitted', {
    uid:      req.user.uid,
    score,
    correct,
    total,
    xpEarned,
    resultId: resultRef.id,
  });

  res.json({ score, correct, total, timeTaken: timeTaken || 0, xpEarned, breakdown, resultId: resultRef.id });
}));

// ─── Weak-topic tracking ─────────────────────────────────────────────────────
// The dashboard's Focus Areas card (web HomeView, app ProgressNotebook) reads
// `weakTopics` off users/{uid}/ml/profile. nltc-ml would normally own that
// field with a proper BKT estimate, but it is not deployed — ML_SERVICE_URL is
// unset — so nothing has ever written it and the card has been permanently
// empty. Every answer already arrives here tagged with its subject and topic,
// so the tally is kept in this route instead. If nltc-ml is ever switched on,
// its richer estimate simply overwrites this one on the same field.

// The `subject` on an answer is whatever string the client sent, so the same
// subject arrives spelled several ways — "English Language", "english_language",
// "english-language". Both dashboards render `weakTopics.subject` through a
// humaniser that only understands underscores, and the web card matches
// suggested videos with `slugifySubject(video.subject)`, so anything else
// displays wrong and matches nothing. This is that same slugify rule, kept
// identical to `slugifySubject` in the web app's src/utils/subjects.js.
const subjectSlug = (subject) => (subject || '')
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

// Firestore map keys may not contain '/', '.', '~', '*', '[' or ']', and topic
// names routinely do ("Algebra I / II"). The readable topic is stored inside the
// entry, so the key only has to be legal and stable.
function topicStatKey(subject, topic) {
  return `${subject}__${topic}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 180);
}

// Smoothed mastery — the mean of a Beta(1,1) posterior rather than raw
// accuracy. A student who gets their first question on a topic wrong sits at
// 33%, not 0%, so one careless slip cannot outrank a topic they have actually
// struggled with all session.
const masteryOf = (correct, attempts) => (correct + 1) / (attempts + 2);

const WEAK_TOPIC_MIN_ATTEMPTS = 3;    // below this there is nothing to conclude
const WEAK_TOPIC_MASTERY_MAX  = 0.7;  // at or above, the topic is not a worry
const WEAK_TOPIC_LIMIT        = 6;    // the card shows chips, not a report

// Folds this sitting's answers into the running tally and returns both halves
// of what gets stored: the updated per-topic counts, and the shortlist the
// dashboards render.
function updateTopicStats(existing, answers) {
  const stats = { ...(existing || {}) };

  for (const a of answers) {
    const topic   = (a.topic || '').trim();
    const subject = subjectSlug(a.subject);
    // An untagged question tells us nothing about a topic. Most of the older
    // bank has no topic field, which is fine — it still counts for coverage.
    if (!topic || !subject) continue;

    const key  = topicStatKey(subject, topic);
    if (!key) continue;
    const prev = stats[key] || { subject, topic, attempts: 0, correct: 0 };
    stats[key] = {
      subject,
      topic,
      attempts: (prev.attempts || 0) + 1,
      correct:  (prev.correct  || 0) + (a.correct ? 1 : 0),
    };
  }

  const weakTopics = Object.values(stats)
    .filter(t => t.attempts >= WEAK_TOPIC_MIN_ATTEMPTS)
    .map(t => ({
      subject:  t.subject,
      topic:    t.topic,
      attempts: t.attempts,
      pMastery: Math.round(masteryOf(t.correct, t.attempts) * 1000) / 1000,
    }))
    .filter(t => t.pMastery < WEAK_TOPIC_MASTERY_MAX)
    .sort((a, b) => a.pMastery - b.pMastery)
    .slice(0, WEAK_TOPIC_LIMIT);

  return { stats, weakTopics };
}

// ─── POST /api/cbt/record-answers ────────────────────────────────────────────
// Logs per-question answers for the smart learning engine (nltc-ml). Writes a
// durable raw log synchronously (so nothing is lost), then fire-and-forgets a
// scoring call to nltc-ml — this must never block or fail the exam-submission
// flow, so the ML call's outcome is deliberately not awaited into the response.
router.post(
  '/record-answers',
  requireAuth,
  [
    body('answers').isArray({ min: 1 }).withMessage('answers must be a non-empty array'),
    body('answers.*.questionId').isString().notEmpty(),
    body('answers.*.subject').isString().notEmpty(),
    body('answers.*.topic').optional({ nullable: true }).isString(),
    body('answers.*.difficultyLabel').optional({ nullable: true }).isString(),
    body('answers.*.correct').isBoolean(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const db  = getDb();
    const uid = req.user.uid;

    const batchRef = await db.collection('interactionBatches').add({
      uid,
      answers:     req.body.answers,
      processed:   false,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Maintain the seen-question map and the weak-topic tally on
    // users/{uid}/ml/profile directly. The dashboard's Subject Coverage card and
    // the adaptive question ranker read seenQuestions from this doc, and the
    // Focus Areas card reads weakTopics; nltc-ml (when deployed) only adds
    // Elo/BKT fields on top, so this merge is safe either way.
    //
    // A transaction because weakTopics is derived from the running totals, so
    // the tally has to be read before it can be rewritten — increments alone
    // cannot express it.
    try {
      const profileRef = db.collection('users').doc(uid).collection('ml').doc('profile');

      const seenUpdate = {};
      for (const a of req.body.answers) {
        seenUpdate[a.questionId] = {
          seenCount:  admin.firestore.FieldValue.increment(1),
          lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
        };
      }

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(profileRef);
        const { stats, weakTopics } = updateTopicStats(
          snap.exists ? snap.data().topicStats : {},
          req.body.answers,
        );

        tx.set(profileRef, {
          seenQuestions: seenUpdate,
          seenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          topicStats:    stats,
          weakTopics,
        }, { merge: true });
      });
    } catch (err) {
      logger.warn('ml profile merge failed (coverage and focus areas may lag until next session)', {
        uid, error: err.message,
      });
    }

    res.json({ success: true });

    if (process.env.ML_SERVICE_URL) {
      axios.post(
        `${process.env.ML_SERVICE_URL}/internal/score`,
        { uid, batchId: batchRef.id, answers: req.body.answers },
        { headers: { 'X-Internal-Key': process.env.ML_INTERNAL_KEY }, timeout: 5000 },
      ).catch(err => {
        logger.warn('nltc-ml scoring call failed (will be caught by nightly reconciliation)', {
          uid, batchId: batchRef.id, error: err.message,
        });
      });
    }
  }),
);

// ─── GET /api/cbt/scores (admin) ─────────────────────────────────────────────
// Returns CBT results across all students (or a single student).
router.get('/scores', requireAdmin, asyncHandler(async (req, res) => {
  const db = getDb();
  const { subject, exam, limit = 100, studentId } = req.query;
  const allScores = [];

  const processResults = async (uid, userData) => {
    const resSnap = await db
      .collection('users').doc(uid)
      .collection('results')
      .orderBy('submittedAt', 'desc')
      .limit(50)
      .get();

    resSnap.forEach(r => {
      const d = r.data();
      // In-memory filter so we don't need composite indexes
      if (subject && d.subject !== subject) return;
      if (exam    && d.exam    !== exam)    return;
      allScores.push({
        uid,
        studentName: `${userData.firstName || ''} ${userData.lastName || ''}`.trim(),
        email:       userData.email || '',
        plan:        userData.plan  || 'free',
        ...d,
        submittedAt: d.submittedAt?.toDate?.()?.toISOString() || null,
      });
    });
  };

  if (studentId) {
    const userSnap = await db.collection('users').doc(studentId).get();
    if (!userSnap.exists) return res.status(404).json({ error: 'Student not found' });
    await processResults(studentId, userSnap.data());
  } else {
    const usersSnap = await db.collection('users').where('role', '==', 'student').get();
    await Promise.allSettled(usersSnap.docs.map(d => processResults(d.id, d.data())));
  }

  allScores.sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));

  const avg = allScores.length
    ? parseFloat((allScores.reduce((s, r) => s + (r.score || 0), 0) / allScores.length).toFixed(1))
    : 0;

  res.json({
    scores:       allScores.slice(0, parseInt(limit)),
    total:        allScores.length,
    averageScore: avg,
  });
}));

// ─── GET /api/cbt/my-results ─────────────────────────────────────────────────
// Returns the authenticated student's own CBT history.
router.get('/my-results', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const { limit = 20, subject } = req.query;

  const snap = await db
    .collection('users').doc(req.user.uid)
    .collection('results')
    .orderBy('submittedAt', 'desc')
    .limit(parseInt(limit) || 20)
    .get();

  const results = snap.docs
    .map(d => ({
      id:         d.id,
      ...d.data(),
      submittedAt: d.data().submittedAt?.toDate?.()?.toISOString() || null,
    }))
    .filter(r => !subject || r.subject === subject);

  res.json({ results, total: results.length });
}));

module.exports = router;
