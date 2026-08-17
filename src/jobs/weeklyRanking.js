// Weekly ranking archive — runs every Sunday at 23:50 UTC, just before the
// week rolls over.
//
// Weekly XP has no history. `weeklyXp` is reset lazily: the next writer to touch
// a student's counter after Monday compares the stored `weekStart` against the
// current one and starts from zero. That is the right design for the live board
// — no sweep, no window where the board is half-reset — but it means that once
// Monday arrives, the week that just finished is gone. Nobody can go back and
// ask who came top in the second week of August, which is exactly the question
// you have to answer to hand out a prize for it.
//
// So this writes the standings down before they vanish. One document per week,
// keyed by that week's Monday, holding the ordered top students and the numbers
// behind them — a record, not a cache, and the reason it is captured at 23:50
// on Sunday rather than after midnight: at that moment every counter still
// belongs to the week being archived. Reading them on Monday would race the
// lazy reset and lose whoever studied early.
const cron  = require('node-cron');
const admin = require('firebase-admin');
const { getDb }        = require('../../config/firebase');
const { getWeekStart } = require('../utils/week');
const logger           = require('../utils/logger');

/** How many students an archived week keeps. Deep enough to move the cut-off later. */
const ARCHIVE_DEPTH = 50;

const STAFF_ROLES = new Set(['admin', 'super_admin']);

/** The Sunday that closes the week starting on [weekStart] (YYYY-MM-DD, UTC). */
function weekEndOf(weekStart) {
  const monday = new Date(`${weekStart}T00:00:00.000Z`);
  const sunday = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000);
  return sunday.toISOString().slice(0, 10);
}

/**
 * Archives one week's standings.
 *
 * Idempotent by design: re-running for the same week overwrites the document
 * rather than adding to it, so a manual capture, a retry after a failed cron and
 * the cron itself all converge on the same record.
 *
 * @param {string} [weekStart] the week to capture; defaults to the live week
 * @returns {Promise<{weekStart: string, entries: number, skipped?: string}>}
 */
async function captureWeeklyRanking(weekStart = getWeekStart()) {
  const db = getDb();

  // Only students whose counter belongs to this week — everyone else is
  // carrying a stale total from a week they were last active in, and ordering
  // by `weeklyXp` without this filter would let those old numbers crowd out the
  // people who actually studied. Same filter the live board uses.
  const snap = await db.collection('users')
    .where('weekStart', '==', weekStart)
    .orderBy('weeklyXp', 'desc')
    .limit(ARCHIVE_DEPTH + 20)   // headroom for the staff filtered out below
    .get();

  const top = snap.docs
    .map(d => {
      const u = d.data();
      return {
        uid:        d.id,
        role:       u.role       || 'student',
        firstName:  u.firstName  || '',
        lastName:   u.lastName   || '',
        email:      u.email      || '',
        state:      u.state      || '',
        targetExam: u.targetExam || '',
        center:     u.center     || null,
        weeklyXp:   u.weeklyXp   || 0,
        xp:         u.xp         || 0,
        streak:     u.streak     || 0,
      };
    })
    .filter(u => !STAFF_ROLES.has(u.role) && u.weeklyXp > 0)
    .slice(0, ARCHIVE_DEPTH)
    .map(({ role, ...student }, i) => ({ ...student, rank: i + 1 }));

  // A week nobody earned in is still a week that happened. Recording it empty
  // is what makes "every week since we started" a complete list rather than a
  // list with unexplained gaps.
  await db.collection('weeklyRankings').doc(weekStart).set({
    weekStart,
    weekEnd:      weekEndOf(weekStart),
    top,
    studentCount: top.length,
    topXp:        top[0]?.weeklyXp || 0,
    capturedAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  logger.info('Weekly ranking archived', { weekStart, entries: top.length });
  return { weekStart, entries: top.length };
}

function startWeeklyRankingJob() {
  // Sunday 23:50 UTC — ten minutes before the counters belong to a new week.
  cron.schedule('50 23 * * 0', () => {
    captureWeeklyRanking().catch(err =>
      logger.error('Weekly ranking archive failed', { err: err.message })
    );
  }, { timezone: 'UTC' });

  logger.info('Weekly ranking archive scheduled (Sundays 23:50 UTC)');
}

module.exports = { startWeeklyRankingJob, captureWeeklyRanking, ARCHIVE_DEPTH };
