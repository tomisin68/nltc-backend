const express        = require('express');
const { body, query }= require('express-validator');
const { requireAuth }= require('../middleware/auth');
const { validate }   = require('../middleware/validate');
const asyncHandler   = require('../utils/asyncHandler');
const logger         = require('../utils/logger');
const { getDb }      = require('../../config/firebase');
const admin          = require('firebase-admin');

const router = express.Router();
router.use(requireAuth);

// ─── XP spec (matches documentation exactly) ────────────────────────────────
const STREAK_BONUS = 50; // awarded on top of base XP when streak increments

function computeBaseXP(action, meta = {}) {
  const score = Number(meta.score) || 0;
  switch (action) {
    case 'watch_lesson': return 20;
    case 'join_live':    return 30;
    case 'first_login':  return 100;
    // spec formula: Math.round(score * 0.5) + (score >= 70 ? 20 : 0), max 70 XP
    case 'cbt_session':  return Math.round(score * 0.5) + (score >= 70 ? 20 : 0);
    default: throw new Error(`Unknown action: ${action}`);
  }
}

// ─── Level thresholds ────────────────────────────────────────────────────────
function xpToLevel(xp) {
  const thresholds = [0, 500, 1500, 3500, 7000, 12000, 20000];
  let level = 1;
  for (let i = 0; i < thresholds.length; i++) {
    if (xp >= thresholds[i]) level = i + 1;
  }
  level = Math.min(level, thresholds.length);
  return {
    level,
    nextLevelXP: thresholds[level]     ?? thresholds[thresholds.length - 1],
    prevLevelXP: thresholds[level - 1] ?? 0,
  };
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate()
  );
}

function isYesterday(d) {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return isSameDay(d, y);
}

// ─── Core award function (Firestore transaction) ─────────────────────────────
async function awardXP(uid, action, meta = {}) {
  const db      = getDb();
  const userRef = db.collection('users').doc(uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');

    const profile = snap.data();

    // first_login is once-ever — idempotent
    if (action === 'first_login' && profile.firstLoginXpAwarded) {
      return {
        newXP:              profile.xp || 0,
        xpEarned:           0,
        newStreak:          profile.streak || 0,
        streakBonusAwarded: false,
        alreadyAwarded:     true,
        leveledUp:          false,
        ...xpToLevel(profile.xp || 0),
      };
    }

    let xpEarned = computeBaseXP(action, meta);

    // ── Streak (not applied to first_login) ──────────────────────────
    const last   = profile.lastActivityAt?.toDate?.() ?? null;
    const now    = new Date();
    let   streak = profile.streak || 0;
    let   streakBonusAwarded = false;

    if (action !== 'first_login') {
      if (!last) {
        streak = 1;
      } else if (isSameDay(last, now)) {
        // same day — no streak change, no bonus
      } else if (isYesterday(last)) {
        streak++;
        xpEarned          += STREAK_BONUS;
        streakBonusAwarded = true;
      } else {
        streak = 1; // gap — reset
      }
    }

    const oldXP     = profile.xp || 0;
    const newXP     = oldXP + xpEarned;
    const oldLevel  = xpToLevel(oldXP).level;
    const levelInfo = xpToLevel(newXP);
    const leveledUp = levelInfo.level > oldLevel;

    const updates = {
      xp:             newXP,
      streak,
      lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (action === 'first_login') updates.firstLoginXpAwarded = true;

    tx.update(userRef, updates);

    return { newXP, xpEarned, newStreak: streak, streakBonusAwarded, leveledUp, ...levelInfo };
  });
}

// ─── POST /gamification/xp ───────────────────────────────────────────────────
router.post(
  '/xp',
  [
    body('action')
      .isIn(['watch_lesson', 'cbt_session', 'join_live', 'first_login'])
      .withMessage('action must be one of: watch_lesson, cbt_session, join_live, first_login'),
    body('meta').optional().isObject().withMessage('meta must be an object'),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const result = await awardXP(req.user.uid, req.body.action, req.body.meta || {});
    logger.info('XP awarded', {
      uid:      req.user.uid,
      action:   req.body.action,
      xpEarned: result.xpEarned,
      newXP:    result.newXP,
    });
    res.json({ success: true, ...result });
  }),
);

// ─── POST /gamification/cbt-session ─────────────────────────────────────────
// Saves session to Firestore AND awards XP using the spec formula.
router.post(
  '/cbt-session',
  [
    body('subject').notEmpty().trim().withMessage('subject is required'),
    body('exam').optional().trim(),
    body('score').isFloat({ min: 0, max: 100 }).withMessage('score must be 0–100'),
    body('correct').isInt({ min: 0 }).withMessage('correct must be a non-negative integer'),
    body('total').isInt({ min: 1 }).withMessage('total must be at least 1'),
    body('topic').optional().trim(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const db  = getDb();
    const uid = req.user.uid;
    const now = admin.firestore.FieldValue.serverTimestamp();

    const sessionData = {
      userId:      uid,
      subject:     req.body.subject,
      exam:        req.body.exam  || 'JAMB / UTME',
      score:       req.body.score,
      correct:     req.body.correct,
      total:       req.body.total,
      topic:       req.body.topic || null,
      submittedAt: now,
    };

    // Write to top-level (admin analytics) AND user subcollection (dashboard history)
    const sessRef   = db.collection('cbtSessions').doc();
    const resultRef = db.collection('users').doc(uid).collection('results').doc(sessRef.id);
    await Promise.all([sessRef.set(sessionData), resultRef.set(sessionData)]);

    // XP via spec formula — cbt_session uses score-based compute
    const result = await awardXP(uid, 'cbt_session', { score: req.body.score });

    logger.info('CBT session saved', {
      uid,
      sessionId: sessRef.id,
      score:     req.body.score,
      xpEarned:  result.xpEarned,
    });
    res.status(201).json({ success: true, sessionId: sessRef.id, ...result });
  }),
);

// ─── GET /gamification/leaderboard ──────────────────────────────────────────
router.get(
  '/leaderboard',
  [
    query('limit')
      .optional()
      .isInt({ min: 1, max: 50 })
      .withMessage('limit must be 1–50'),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const db  = getDb();
    const lim = parseInt(req.query.limit || '20', 10);

    const snap = await db.collection('users').orderBy('xp', 'desc').limit(lim).get();

    const board = snap.docs
      .map((d, i) => ({
        rank:       i + 1,
        uid:        d.id,
        firstName:  d.data().firstName  || '',
        lastName:   d.data().lastName   || '',
        state:      d.data().state      || '—',
        targetExam: d.data().targetExam || '—',
        xp:         d.data().xp         || 0,
        streak:     d.data().streak     || 0,
        plan:       d.data().plan       || 'free',
      }))
      .filter(u => u.role !== 'admin' && u.role !== 'super_admin');

    const myEntry = board.find(s => s.uid === req.user.uid);

    res.json({ success: true, leaderboard: board, myRank: myEntry?.rank ?? null });
  }),
);

// ─── GET /gamification/rank ──────────────────────────────────────────────────
router.get(
  '/rank',
  asyncHandler(async (req, res) => {
    const db = getDb();

    const userSnap = await db.collection('users').doc(req.user.uid).get();
    if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

    const myXP   = userSnap.data().xp    || 0;
    const streak = userSnap.data().streak || 0;

    const [aboveSnap, totalSnap] = await Promise.all([
      db.collection('users').where('xp', '>', myXP).count().get(),
      db.collection('users').where('role', '==', 'student').count().get(),
    ]);

    const rank          = aboveSnap.data().count + 1;
    const totalStudents = totalSnap.data().count;

    res.json({
      success: true,
      rank,
      xp: myXP,
      streak,
      totalStudents,
      ...xpToLevel(myXP),
    });
  }),
);

module.exports = router;
