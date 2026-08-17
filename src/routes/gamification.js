const express        = require('express');
const { body, query }= require('express-validator');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate }   = require('../middleware/validate');
const asyncHandler   = require('../utils/asyncHandler');
const logger         = require('../utils/logger');
const { getDb }      = require('../../config/firebase');
// Shared with referralService, which also writes weeklyXp — the lazy reset only
// works if every writer agrees on where the week starts.
const { getWeekStart } = require('../utils/week');
const { captureWeeklyRanking } = require('../jobs/weeklyRanking');
const admin          = require('firebase-admin');

const router = express.Router();

// ─── GET /gamification/public-stats ─────────────────────────────────────────
// Unauthenticated, and deliberately mounted above router.use(requireAuth).
//
// The landing page used to sign visitors in anonymously and read /users
// directly for its top-5 board and headline counts. Firestore reads are
// whole-document, so that handed every anonymous visitor the full profile —
// email, phone, address, guardian contacts — of every student. This returns
// the four display fields the page actually renders and nothing else, so the
// rules can (and now do) refuse anonymous principals outright.
const publicStatsCache = { data: null, cachedAt: 0 };
const PUBLIC_STATS_TTL = 300_000; // 5 min — this is a marketing figure, not live data

router.get('/public-stats', asyncHandler(async (req, res) => {
  const now = Date.now();
  if (publicStatsCache.data && now - publicStatsCache.cachedAt < PUBLIC_STATS_TTL) {
    return res.json({ success: true, ...publicStatsCache.data });
  }

  const db = getDb();
  const countOf = (name) =>
    db.collection(name).count().get().then(s => s.data().count).catch(() => 0);

  const [boardSnap, studentCount, srQuestions, jrQuestions] = await Promise.all([
    db.collection('users').orderBy('xp', 'desc').limit(15).get(),
    db.collection('users').count().get().then(s => s.data().count).catch(() => null),
    countOf('questions'),
    countOf('jssQuestions'),
  ]);

  // Names, state, XP and the self-chosen avatar — what the podium renders.
  // No email, phone, plan or uid: this response is served to anyone.
  const leaders = boardSnap.docs
    .map(d => ({
      role:         d.data().role         || 'student',
      firstName:    d.data().firstName    || '',
      lastName:     d.data().lastName     || '',
      state:        d.data().state        || '—',
      xp:           d.data().xp           || 0,
      profileImage: d.data().profileImage || d.data().photoURL || null,
    }))
    .filter(u => u.role !== 'admin' && u.role !== 'super_admin')
    .slice(0, 5)
    .map(({ role, ...safe }) => safe); // role was only needed to filter staff out

  const payload = { leaders, studentCount, questionCount: srQuestions + jrQuestions };
  publicStatsCache.data     = payload;
  publicStatsCache.cachedAt = now;
  res.json({ success: true, ...payload });
}));

router.use(requireAuth);

// ─── XP spec (matches documentation exactly) ────────────────────────────────
const STREAK_BONUS = 50; // awarded on top of base XP when streak increments

function computeBaseXP(action, meta = {}) {
  const score = Number(meta.score) || 0;
  switch (action) {
    case 'watch_lesson':  return 20;
    case 'join_live':     return 30;
    case 'first_login':   return 100;
    case 'daily_streak':   return 0;   // streak bonus (+50) is added by streak logic
    case 'daily_mission':  return 25;  // per completed daily mission task
    // spec formula: Math.round(score * 0.5) + (score >= 70 ? 20 : 0), max 70 XP
    case 'cbt_session':    return Math.round(score * 0.5) + (score >= 70 ? 20 : 0);
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

// ─── Achievement definitions (mirrors frontend ALL_ACHIEVEMENTS) ──────────────
//
// Each test is a statement about the profile, not about the request that
// happened to be in flight — `first_lesson` asks "has this student ever been
// paid for a lesson", not "is this call a lesson". That distinction is what lets
// the same list settle a badge on any read, rather than only on the one award
// that first crossed the line. See `missingAchievements`.
const ACHIEVEMENT_CHECKS = [
  { id: 'first_lesson', test: ({ lessonsWatched })  => lessonsWatched >= 1 },
  { id: 'streak_3',     test: ({ streak })          => streak >= 3 },
  { id: 'streak_7',     test: ({ streak })          => streak >= 7 },
  { id: 'cbt_5',        test: ({ cbtCount })        => cbtCount >= 5 },
  { id: 'cbt_10',       test: ({ cbtCount })        => cbtCount >= 10 },
  { id: 'xp_500',       test: ({ xp })              => xp >= 500 },
  { id: 'xp_1000',      test: ({ xp })              => xp >= 1000 },
];

/**
 * Badges this student has earned but does not yet hold.
 *
 * Achievements used to be evaluated only on the branch of `awardXP` that
 * actually paid out. Every idempotent path — the day's second `daily_streak`,
 * a re-watched lesson, `first_login` after the first — returned before the
 * checks ran, and any badge whose bar had been crossed on one of those calls
 * was never written. `first_lesson` was the worst hit: a student who had
 * watched lessons still had no badge for it, and could only earn it by finding
 * a video they had never opened before.
 *
 * Taking the profile rather than the request makes the answer depend only on
 * where the student stands, so the same call repairs a gap left months ago.
 */
function missingAchievements(profile, overrides = {}) {
  const held = new Set(profile.achievements || []);
  const stats = {
    xp:             overrides.xp             ?? profile.xp             ?? 0,
    streak:         overrides.streak         ?? profile.streak         ?? 0,
    cbtCount:       overrides.cbtCount       ?? profile.cbtCount       ?? 0,
    lessonsWatched: overrides.lessonsWatched ?? profile.lessonsWatched ?? 0,
  };
  return ACHIEVEMENT_CHECKS
    .filter(({ id, test }) => !held.has(id) && test(stats))
    .map(({ id }) => id);
}

// ─── Core award function (Firestore transaction) ─────────────────────────────
async function awardXP(uid, action, meta = {}) {
  const db      = getDb();
  const userRef = db.collection('users').doc(uid);

  // A lesson pays out once per video, ever — see the collection comment below.
  // The receipt is read inside the transaction so two taps landing together
  // cannot both find it missing.
  const videoId    = action === 'watch_lesson' ? String(meta.videoId || '') : '';
  if (action === 'watch_lesson' && !videoId) {
    // Without it there is nothing to deduplicate against, which is exactly the
    // request an XP farmer would send. The route rejects this first; this is
    // the backstop for any future caller.
    throw new Error('watch_lesson requires meta.videoId');
  }
  // Escaped so any id a client can send is a legal document id — `/` is illegal
  // in one, and `.` / `..` are reserved names on their own.
  const lessonRef  = videoId
    ? userRef.collection('lessonXp').doc(encodeURIComponent(videoId).replace(/\./g, '%2E'))
    : null;

  return db.runTransaction(async (tx) => {
    // Firestore requires every read in a transaction to precede every write.
    const [snap, lessonSnap] = await Promise.all([
      tx.get(userRef),
      lessonRef ? tx.get(lessonRef) : Promise.resolve(null),
    ]);
    if (!snap.exists) throw new Error('User not found');

    const profile = snap.data();

    // No XP this time — but still a chance to settle a badge the student has
    // already earned and never been given. These branches used to return with
    // `newAchievements: []` unconditionally, which is how a student could sit
    // above every threshold with an empty medal row.
    const alreadyPaid = (xp, { alreadyAwarded = true, overrides = {} } = {}) => {
      const owed = missingAchievements(profile, overrides);
      if (owed.length > 0) {
        tx.update(userRef, {
          achievements: admin.firestore.FieldValue.arrayUnion(...owed),
        });
      }
      return {
        newXP:              xp,
        xpEarned:           0,
        newStreak:          profile.streak || 0,
        streakBonusAwarded: false,
        alreadyAwarded,
        leveledUp:          false,
        newAchievements:    owed,
        ...xpToLevel(xp),
      };
    };

    // first_login is once-ever — idempotent
    if (action === 'first_login' && profile.firstLoginXpAwarded) {
      return alreadyPaid(profile.xp || 0);
    }

    // watch_lesson is once per video, ever. Opening a lesson used to pay 20 XP
    // every time, so the leaderboard rewarded whoever opened and closed the
    // most videos rather than whoever studied. A second viewing is still
    // welcome — it just isn't paid for again.
    if (lessonSnap?.exists) {
      // The receipt is proof this student has watched a lesson, whatever the
      // counter says — students from before `lessonsWatched` existed have
      // receipts and a zero, and this is where they finally collect the badge.
      return alreadyPaid(profile.xp || 0, { overrides: { lessonsWatched: 1 } });
    }

    let xpEarned = computeBaseXP(action, meta);

    // ── Streak (not applied to first_login) ──────────────────────────
    const last   = profile.lastActivityAt?.toDate?.() ?? null;
    const now    = new Date();
    let   streak = profile.streak || 0;
    let   streakBonusAwarded = false;

    // daily_streak is idempotent — if already fired today (same day), return no XP
    if (action === 'daily_streak' && last && isSameDay(last, now)) {
      return alreadyPaid(profile.xp || 0, { alreadyAwarded: false });
    }

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

    // ── cbtCount: increment atomically on cbt_session ────────────────
    const newCbtCount = (profile.cbtCount || 0) + (action === 'cbt_session' ? 1 : 0);

    // Counts lessons paid for, which is what `first_lesson` is really asking
    // about. It used to be inferred from the action alone, so the badge existed
    // only for the instant of the award and was lost with it.
    const newLessonsWatched = (profile.lessonsWatched || 0) + (lessonRef ? 1 : 0);

    // ── Achievements: unlock any newly qualifying badges ──────────────
    const newAchievements = missingAchievements(profile, {
      xp:             newXP,
      streak,
      cbtCount:       newCbtCount,
      lessonsWatched: newLessonsWatched,
    });

    // ── Weekly XP: reset on new week (Monday UTC), then add ─────────────
    const currentWeekStart = getWeekStart();
    const isNewWeek = (profile.weekStart || '') !== currentWeekStart;
    const newWeeklyXp = (isNewWeek ? 0 : (profile.weeklyXp || 0)) + xpEarned;

    const updates = {
      xp:             newXP,
      streak,
      cbtCount:       newCbtCount,
      lessonsWatched: newLessonsWatched,
      lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
      weeklyXp:       newWeeklyXp,
      weekStart:      currentWeekStart,
    };
    if (action === 'first_login') updates.firstLoginXpAwarded = true;
    // arrayUnion, not the rebuilt array: `GET /rank` awards top_10 / top_50
    // outside this transaction, and writing a whole list assembled from a
    // profile read a moment earlier would drop a rank badge that landed in
    // between.
    if (newAchievements.length > 0) {
      updates.achievements = admin.firestore.FieldValue.arrayUnion(...newAchievements);
    }

    tx.update(userRef, updates);

    // The receipt that stops this video paying out again. Written last so a
    // failed award never leaves a student unable to earn the XP at all.
    if (lessonRef) {
      tx.set(lessonRef, {
        videoId,
        xpEarned:   xpEarned,
        awardedAt:  admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return {
      newXP, xpEarned, newStreak: streak, streakBonusAwarded, leveledUp,
      newCbtCount, newAchievements, newWeeklyXp,
      ...levelInfo,
    };
  });
}

// ─── POST /gamification/xp ───────────────────────────────────────────────────
router.post(
  '/xp',
  [
    body('action')
      .isIn(['watch_lesson', 'cbt_session', 'join_live', 'first_login', 'daily_streak', 'daily_mission'])
      .withMessage('action must be one of: watch_lesson, cbt_session, join_live, first_login, daily_streak, daily_mission'),
    body('meta').optional().isObject().withMessage('meta must be an object'),
    // A lesson award is keyed by the video it is for, so the video has to be
    // named. `encodeURIComponent` makes it a legal document id; the length cap
    // keeps that inside Firestore's 1,500-byte limit.
    body('meta.videoId')
      .if(body('action').equals('watch_lesson'))
      .isString().bail()
      .trim()
      .isLength({ min: 1, max: 200 })
      .withMessage('meta.videoId is required for watch_lesson'),
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

// ─── Leaderboard cache (60 s TTL) ───────────────────────────────────────────
const leaderboardCache = new Map(); // key: lim → { board, cachedAt }
const LEADERBOARD_TTL  = 60_000;

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
    const now = Date.now();

    const cached = leaderboardCache.get(lim);
    if (cached && now - cached.cachedAt < LEADERBOARD_TTL) {
      const myEntry = cached.board.find(s => s.uid === req.user.uid);
      return res.json({ success: true, leaderboard: cached.board, myRank: myEntry?.rank ?? null });
    }

    const snap = await db.collection('users').orderBy('xp', 'desc').limit(lim).get();

    const board = snap.docs
      .map(d => ({
        uid:        d.id,
        role:       d.data().role       || 'student',
        firstName:  d.data().firstName  || '',
        lastName:   d.data().lastName   || '',
        state:      d.data().state      || '—',
        targetExam: d.data().targetExam || '—',
        xp:         d.data().xp         || 0,
        streak:     d.data().streak     || 0,
        plan:       d.data().plan       || 'free',
      }))
      .filter(u => u.role !== 'admin' && u.role !== 'super_admin')
      .map((u, i) => ({ ...u, rank: i + 1 })); // re-rank after admins removed

    leaderboardCache.set(lim, { board, cachedAt: now });

    const myEntry = board.find(s => s.uid === req.user.uid);
    res.json({ success: true, leaderboard: board, myRank: myEntry?.rank ?? null });
  }),
);

// ─── GET /gamification/leaderboard/weekly ────────────────────────────────────
const weeklyCache = new Map(); // key: lim → { board, cachedAt }
router.get(
  '/leaderboard/weekly',
  asyncHandler(async (req, res) => {
    const db  = getDb();
    const lim = Math.min(parseInt(req.query.limit || '10', 10), 20);
    const now = Date.now();

    const cached = weeklyCache.get(lim);
    if (cached && now - cached.cachedAt < 60_000) {
      const myEntry = cached.board.find(s => s.uid === req.user.uid);
      return res.json({ success:true, leaderboard:cached.board, weekStart:getWeekStart(), myRank:myEntry?.rank ?? null });
    }

    // Only users who've earned XP THIS week have an up-to-date weeklyXp value —
    // it's reset lazily inside awardXP(), not by a scheduled job — so filter on
    // weekStart before ordering, otherwise stale prior-week values (which can be
    // large) crowd out this week's real leaders from the top-N query window.
    const snap = await db.collection('users')
      .where('weekStart', '==', getWeekStart())
      .orderBy('weeklyXp', 'desc')
      .limit(lim + 10)
      .get();
    const board = snap.docs
      .map(d => ({
        uid:        d.id,
        role:       d.data().role       || 'student',
        firstName:  d.data().firstName  || '',
        lastName:   d.data().lastName   || '',
        state:      d.data().state      || '—',
        targetExam: d.data().targetExam || '—',
        weeklyXp:   d.data().weeklyXp   || 0,
        xp:         d.data().xp         || 0,
      }))
      .filter(u => u.role !== 'admin' && u.role !== 'super_admin')
      .sort((a, b) => b.weeklyXp - a.weeklyXp)
      .slice(0, lim)
      .map((u, i) => ({ ...u, rank: i + 1 }));

    weeklyCache.set(lim, { board, cachedAt: now });
    const myEntry = board.find(s => s.uid === req.user.uid);
    res.json({ success:true, leaderboard:board, weekStart:getWeekStart(), myRank:myEntry?.rank ?? null });
  }),
);

// ─── GET /gamification/rank ──────────────────────────────────────────────────
router.get(
  '/rank',
  asyncHandler(async (req, res) => {
    const db = getDb();

    const userRef  = db.collection('users').doc(req.user.uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

    const profile = userSnap.data();
    const myXP   = profile.xp    || 0;
    const streak = profile.streak || 0;

    let rank = null, totalStudents = null;
    try {
      // Requires composite index: users(role ASC, xp ASC) — see firestore.indexes.json
      const [aboveSnap, totalSnap] = await Promise.all([
        db.collection('users').where('role', '==', 'student').where('xp', '>', myXP).count().get(),
        db.collection('users').where('role', '==', 'student').count().get(),
      ]);
      rank          = aboveSnap.data().count + 1;
      totalStudents = totalSnap.data().count;
    } catch {
      // Index may still be building — return null rank rather than 500
    }

    /* Settle every badge this student has earned, not just the rank ones.
     *
     * This runs on dashboard load, and it is where a student who has been over
     * a threshold for months finally gets the medal: `awardXP` can only fix a
     * gap on a call that happens to come in, and a student between actions
     * never gets one. Reconciling on a read means the row is right the next
     * time they open the app.
     *
     * `first_lesson` gets a second chance here too. Accounts that pre-date
     * `lessonsWatched` have no such field, so a single `lessonXp` receipt — one
     * per video ever paid for — stands in as the evidence.
     *
     * Keyed on the field being *absent*, not on it being zero: the first XP
     * award of any kind writes the counter, so this probe costs one read per
     * legacy account and then never fires again. Testing for zero instead would
     * charge a read on every dashboard load, forever, to a student who simply
     * has not watched a video yet. */
    const held = new Set(profile.achievements || []);
    let lessonsWatched = profile.lessonsWatched || 0;
    if (profile.lessonsWatched === undefined && !held.has('first_lesson')) {
      const receipt = await userRef.collection('lessonXp').limit(1).get().catch(() => null);
      if (receipt && !receipt.empty) lessonsWatched = 1;
    }

    const newAchievements = missingAchievements(profile, { lessonsWatched });
    if (rank !== null) {
      if (rank <= 10 && !held.has('top_10')) newAchievements.push('top_10');
      if (rank <= 50 && !held.has('top_50')) newAchievements.push('top_50');
    }
    if (newAchievements.length > 0) {
      await userRef.update({
        achievements: admin.firestore.FieldValue.arrayUnion(...newAchievements),
      });
      logger.info('Backfilled achievements', { uid: req.user.uid, newAchievements });
    }

    res.json({
      success: true,
      rank,
      xp: myXP,
      streak,
      totalStudents,
      newAchievements,
      ...xpToLevel(myXP),
    });
  }),
);

// ─── Weekly ranking archive (admin) ──────────────────────────────────────────
//
// The live weekly board only ever shows this week, because `weeklyXp` resets
// lazily and keeps no history. These read the archive that jobs/weeklyRanking.js
// writes every Sunday night — which is what makes "who came top in the week of
// the 4th" a question with an answer, and therefore a week you can reward.

// ─── GET /gamification/weekly-rankings ───────────────────────────────────────
// Every archived week, newest first — the index for the admin's week picker.
// Deliberately without the `top` array: forty weeks of fifty students each is a
// large response to send when all the picker needs is a list of dates.
router.get(
  '/weekly-rankings',
  requireAdmin,
  [query('limit').optional().isInt({ min: 1, max: 200 })],
  validate,
  asyncHandler(async (req, res) => {
    const lim  = Math.min(parseInt(req.query.limit || '104', 10), 200);
    const snap = await getDb().collection('weeklyRankings')
      .orderBy('weekStart', 'desc')
      .limit(lim)
      .get();

    res.json({
      success: true,
      weeks: snap.docs.map(d => {
        const w = d.data();
        return {
          weekStart:    w.weekStart,
          weekEnd:      w.weekEnd || null,
          studentCount: w.studentCount || 0,
          topXp:        w.topXp || 0,
          winner:       w.top?.[0]
            ? {
                uid:  w.top[0].uid,
                name: `${w.top[0].firstName || ''} ${w.top[0].lastName || ''}`.trim() || w.top[0].email,
                weeklyXp: w.top[0].weeklyXp || 0,
              }
            : null,
          capturedAt: w.capturedAt?.toDate?.()?.toISOString() || null,
        };
      }),
    });
  }),
);

// ─── GET /gamification/weekly-rankings/:weekStart ────────────────────────────
// One week's full standings.
router.get(
  '/weekly-rankings/:weekStart',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { weekStart } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return res.status(400).json({ error: 'weekStart must be a YYYY-MM-DD Monday' });
    }

    const snap = await getDb().collection('weeklyRankings').doc(weekStart).get();
    if (!snap.exists) return res.status(404).json({ error: 'No ranking archived for that week' });

    const w = snap.data();
    res.json({
      success: true,
      week: {
        ...w,
        capturedAt: w.capturedAt?.toDate?.()?.toISOString() || null,
      },
    });
  }),
);

// ─── POST /gamification/weekly-rankings/capture ──────────────────────────────
// Archive a week now, rather than waiting for Sunday night.
//
// Two jobs. It is how the week in progress gets recorded the first time this
// ships — otherwise the archive starts a week late and the current week's
// standings are lost to the reset like every week before it. And it is the
// retry when the cron did not run, which on a host that sleeps is not rare.
//
// Overwrites, so pressing it twice is harmless.
router.post(
  '/weekly-rankings/capture',
  requireAdmin,
  [body('weekStart').optional().matches(/^\d{4}-\d{2}-\d{2}$/)],
  validate,
  asyncHandler(async (req, res) => {
    const result = await captureWeeklyRanking(req.body.weekStart || getWeekStart());
    logger.info('Weekly ranking captured manually', { ...result, by: req.user.uid });
    res.json({ success: true, ...result });
  }),
);

module.exports = router;
