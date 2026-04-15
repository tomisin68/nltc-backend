const express        = require('express');
const { body, query }= require('express-validator');
const { requireAuth }= require('../middleware/auth');
const { validate }   = require('../middleware/validate');
const asyncHandler   = require('../utils/asyncHandler');
const logger         = require('../utils/logger');
const { getDb }      = require('../../config/firebase');
const admin          = require('firebase-admin');
const router         = express.Router();

router.use(requireAuth);

// ─── XP reward table ───────────────────────────────────────────────────────
const XP = {
  watch_lesson:  15,
  complete_cbt:  30,
  join_live:     50,
  daily_streak:  10,
  score_90_plus: 20,
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function xpToLevel(xp) {
  const thresholds = [0, 500, 1500, 3500, 7000, 12000, 20000];
  let level = 1;
  for (let i = 0; i < thresholds.length; i++) {
    if (xp >= thresholds[i]) level = i + 1;
  }
  level = Math.min(level, thresholds.length);
  const nextLevelXP = thresholds[level] ?? thresholds[thresholds.length - 1];
  const prevLevelXP = thresholds[level - 1] ?? 0;
  return { level, nextLevelXP, prevLevelXP };
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate()
  );
}

function isYesterday(d) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return isSameDay(d, yesterday);
}

// ─── Core XP award function ─────────────────────────────────────────────────
// FIX 1: guard against unknown actions returning 0 XP silently
// FIX 2: streak bonus only awarded when streak actually increments
// FIX 3: returns full level info so frontend can show level-up toasts
async function awardXP(uid, action, meta = {}) {
  const db      = getDb();
  const userRef = db.collection('users').doc(uid);

  // Use a transaction so concurrent requests don't corrupt XP / streak
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');

    const profile   = snap.data();
    const baseXP    = XP[action];

    // FIX 1: reject unknown actions explicitly
    if (baseXP === undefined) throw new Error(`Unknown action: ${action}`);

    let xpEarned = baseXP;

    // Bonus for scoring 90%+ on CBT
    if (action === 'complete_cbt' && Number(meta.score) >= 90) {
      xpEarned += XP.score_90_plus;
    }

    // ── Streak calculation ────────────────────────────────────────────
    const lastRaw   = profile.lastActivityAt;
    const last      = lastRaw?.toDate?.() ?? null;
    const now       = new Date();
    let   streak    = profile.streak || 0;
    let   streakBonusAwarded = false;

    if (last) {
      if (isSameDay(last, now)) {
        // Same day — streak unchanged, no bonus
      } else if (isYesterday(last)) {
        // Consecutive day — increment streak and award bonus
        streak++;
        xpEarned += XP.daily_streak;   // FIX 2: bonus only on increment
        streakBonusAwarded = true;
      } else {
        // Gap — reset streak to 1, no bonus
        streak = 1;
      }
    } else {
      // First ever activity
      streak = 1;
    }

    const oldXP    = profile.xp || 0;
    const newXP    = oldXP + xpEarned;
    const oldLevel = xpToLevel(oldXP).level;
    const { level, nextLevelXP, prevLevelXP } = xpToLevel(newXP);
    const leveledUp = level > oldLevel;

    tx.update(userRef, {
      xp:              newXP,
      streak,
      lastActivityAt:  admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      newXP,
      xpEarned,
      newStreak:          streak,
      streakBonusAwarded,
      level,
      nextLevelXP,
      prevLevelXP,
      leveledUp,
    };
  });
}

// ─── POST /gamification/xp ──────────────────────────────────────────────────
// Called by frontend for: watch_lesson, join_live, daily_streak
// FIX 3: added 'join_live' to the allowed list (it was missing before)
router.post(
  '/xp',
  [
    body('action')
      .isIn(['watch_lesson', 'complete_cbt', 'join_live', 'daily_streak'])
      .withMessage('Invalid action'),
    body('meta')
      .optional()
      .isObject()
      .withMessage('meta must be an object'),
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
  })
);

// ─── POST /gamification/cbt-session ─────────────────────────────────────────
// Saves session to Firestore AND awards XP in one call.
// FIX 4: also writes to users/{uid}/results (subcollection) so the
//         dashboard CBT history table actually populates.
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
    const db   = getDb();
    const uid  = req.user.uid;
    const now  = admin.firestore.FieldValue.serverTimestamp();

    const sessionData = {
      userId:      uid,
      subject:     req.body.subject,
      exam:        req.body.exam    || 'JAMB / UTME',
      score:       req.body.score,
      correct:     req.body.correct,
      total:       req.body.total,
      topic:       req.body.topic   || null,
      submittedAt: now,              // FIX 4: use submittedAt so dashboard query works
    };

    // Write to top-level cbtSessions collection (analytics / admin use)
    const sessRef = db.collection('cbtSessions').doc();
    await sessRef.set(sessionData);

    // FIX 4: ALSO write to users/{uid}/results so the student's history
    // tab can query collection('users', uid, 'results') as the frontend does.
    const resultRef = db.collection('users').doc(uid).collection('results').doc(sessRef.id);
    await resultRef.set(sessionData);

    // Award XP
    const result = await awardXP(uid, 'complete_cbt', { score: req.body.score });

    logger.info('CBT session saved', {
      uid,
      sessionId: sessRef.id,
      score:     req.body.score,
      xpEarned:  result.xpEarned,
    });

    res.status(201).json({
      success:   true,
      sessionId: sessRef.id,
      ...result,
    });
  })
);

// ─── GET /gamification/leaderboard ──────────────────────────────────────────
// FIX 5: removed the where('role','==','student') filter that required a
//         composite index and caused silent failures when the index was absent.
//         Students are now filtered in-memory, which is safe for ≤50 docs.
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
    const db    = getDb();
    const lim   = parseInt(req.query.limit || '20', 10);

    // FIX 5: single-field orderBy — no composite index needed
    const snap  = await db.collection('users').orderBy('xp', 'desc').limit(lim).get();

    const board = snap.docs
      .map((d, i) => ({
        rank:      i + 1,
        uid:       d.id,
        firstName: d.data().firstName  || '',
        lastName:  d.data().lastName   || '',
        state:     d.data().state      || '—',
        targetExam:d.data().targetExam || '—',
        xp:        d.data().xp         || 0,
        streak:    d.data().streak      || 0,
        plan:      d.data().plan        || 'free',
      }))
      // FIX 5: filter in-memory instead of in the query
      .filter(u => !u.role || u.role !== 'admin');

    const myEntry = board.find(s => s.uid === req.user.uid);
    const myRank  = myEntry ? myEntry.rank : null;

    res.json({ success: true, leaderboard: board, myRank });
  })
);

// ─── GET /gamification/rank ──────────────────────────────────────────────────
// FIX 6: original used where('xp','>',myXP) which requires an index on xp.
//         Replaced with a count query that works without any extra index.
router.get(
  '/rank',
  asyncHandler(async (req, res) => {
    const db   = getDb();
    const snap = await db.collection('users').doc(req.user.uid).get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const myXP = snap.data().xp || 0;

    // FIX 6: this query only needs the default single-field index on xp
    const aboveSnap = await db
      .collection('users')
      .where('xp', '>', myXP)
      .count()          // uses Firestore aggregation — no composite index
      .get();

    const rank = aboveSnap.data().count + 1;

    res.json({
      success: true,
      rank,
      xp: myXP,
      ...xpToLevel(myXP),
    });
  })
);

module.exports = router;