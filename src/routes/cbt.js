const express        = require('express');
const admin          = require('firebase-admin');
const { requireAuth, requireAdmin } = require('../middleware/auth');
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
