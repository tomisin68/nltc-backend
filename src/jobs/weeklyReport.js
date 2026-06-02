// Weekly progress report — runs every Sunday at 06:00 Nigeria time (UTC+1 = 05:00 UTC)
const cron   = require('node-cron');
const admin  = require('firebase-admin');
const { getDb }                    = require('../../config/firebase');
const { sendWeeklyProgressEmail }  = require('../services/emailService');
const logger                       = require('../utils/logger');

async function runWeeklyReport() {
  const db  = getDb();
  const now = new Date();

  // Window: last 7 days
  const weekAgo = new Date(now);
  weekAgo.setDate(now.getDate() - 7);
  const weekAgoTs = admin.firestore.Timestamp.fromDate(weekAgo);

  logger.info('Weekly report job started', { date: now.toISOString() });

  let processed = 0, errors = 0;

  try {
    // Fetch all students (not admins)
    const usersSnap = await db.collection('users')
      .where('role', '==', 'student')
      .get();

    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data();
      const email = user.email;
      if (!email) continue;

      // Only send to students who have paid (pro/elite plan OR lesson fee paid)
      const isPaid = ['pro', 'elite'].includes(user.plan) || user.lessonFeePaid === true;
      if (!isPaid) continue;

      try {
        // Fetch CBT sessions from last 7 days
        const resultsSnap = await db
          .collection('users').doc(userDoc.id)
          .collection('results')
          .where('submittedAt', '>=', weekAgoTs)
          .get();

        let cbtSessions = 0, totalCorrect = 0, totalQuestions = 0;
        resultsSnap.docs.forEach(d => {
          const r = d.data();
          cbtSessions++;
          totalCorrect   += r.correct || 0;
          totalQuestions += r.total   || 0;
        });

        // XP earned this week (rough estimate: current XP minus XP a week ago is not stored,
        // so we compute total CBT XP from sessions + lesson/live signals)
        // For now use a reasonable proxy: cbtSessions * 30 (avg) + streak bonus heuristic
        const xpEarned = cbtSessions * 30;

        // Lessons watched this week (tracked via watch events in users/{uid}/watchEvents, if present)
        let lessonsWatched = 0;
        try {
          const watchSnap = await db
            .collection('users').doc(userDoc.id)
            .collection('watchEvents')
            .where('watchedAt', '>=', weekAgoTs)
            .get();
          lessonsWatched = watchSnap.size;
        } catch (_) { /* collection may not exist — skip */ }

        await sendWeeklyProgressEmail({
          email,
          firstName:   user.firstName || '',
          parentEmail: user.parentEmail || null,
          stats: {
            cbtSessions,
            totalCorrect,
            totalQuestions,
            xpEarned,
            streak:          user.streak || 0,
            lessonsWatched,
          },
        });

        processed++;
      } catch (err) {
        errors++;
        logger.error('Weekly report error for user', { uid: userDoc.id, err: err.message });
      }
    }
  } catch (err) {
    logger.error('Weekly report job failed', { err: err.message });
  }

  logger.info('Weekly report job finished', { processed, errors });
}

function startWeeklyReportJob() {
  // Every Sunday at 05:00 UTC (06:00 WAT)
  cron.schedule('0 5 * * 0', () => {
    runWeeklyReport().catch(err =>
      logger.error('Weekly report job unhandled error', { err: err.message })
    );
  }, { timezone: 'UTC' });

  logger.info('Weekly report job scheduled (Sundays 05:00 UTC)');
}

module.exports = { startWeeklyReportJob, runWeeklyReport };
