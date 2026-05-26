// Daily inactivity check — runs every day at 07:00 UTC (08:00 WAT)
// 3-day inactive → email + FCM push to student
// 7-day inactive → email alert to all admins + student's center manager
const cron   = require('node-cron');
const admin  = require('firebase-admin');
const { getDb }                   = require('../../config/firebase');
const { sendInactivityEmail, sendAdminInactivityAlert } = require('../services/emailService');
const { sendPushToTokens }        = require('../services/notificationService');
const logger                      = require('../utils/logger');

const DAY_MS    = 24 * 60 * 60 * 1000;
const GRACE_MS  = 23 * 60 * 60 * 1000; // don't re-send if already sent within 23 h

function wasSentRecently(tsField) {
  if (!tsField) return false;
  const d = tsField.toDate ? tsField.toDate() : new Date(tsField);
  return Date.now() - d.getTime() < GRACE_MS;
}

async function runInactivityCheck() {
  const db  = getDb();
  const now = new Date();
  logger.info('Inactivity check job started', { date: now.toISOString() });

  let notified3d = 0, notified7d = 0, errors = 0;

  try {
    // Fetch admins once for 7-day alerts
    const adminSnap = await db.collection('users')
      .where('role', 'in', ['admin', 'super_admin'])
      .get();
    const adminEmails = adminSnap.docs
      .map(d => d.data().email)
      .filter(Boolean);

    // Fetch all students
    const usersSnap = await db.collection('users')
      .where('role', '==', 'student')
      .get();

    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data();
      if (!user.email) continue;

      const lastActivity = user.lastActivityAt?.toDate?.() ?? null;
      if (!lastActivity) continue;

      const daysSince = (now - lastActivity) / DAY_MS;

      try {
        // ── 3-day inactivity: email + push to student ────────────────────────
        if (daysSince >= 3 && daysSince < 7 && !wasSentRecently(user.lastInactivityEmail3d)) {
          const daysMissed = Math.floor(daysSince);

          // Send email
          await sendInactivityEmail({
            email:      user.email,
            firstName:  user.firstName || '',
            daysMissed,
          });

          // Send FCM push if tokens are stored
          const tokens = user.fcmTokens || [];
          if (tokens.length > 0) {
            await sendPushToTokens(tokens, {
              title: `You've missed ${daysMissed} study days`,
              body:  `Hey ${user.firstName || 'there'}, let's get back on track! Open NLTC to continue studying.`,
              data:  { url: '/dashboard', type: 'inactivity_nudge' },
            });
          }

          // Record timestamp so we don't spam
          await userDoc.ref.update({
            lastInactivityEmail3d: admin.firestore.FieldValue.serverTimestamp(),
          });

          notified3d++;
        }

        // ── 7-day inactivity: alert admins + center manager ──────────────────
        if (daysSince >= 7 && !wasSentRecently(user.lastInactivityEmail7d)) {
          const daysMissed = Math.floor(daysSince);
          const studentName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Unknown';

          // Look up center name if student has one
          let centerName = null;
          if (user.center) {
            try {
              const centerSnap = await db.collection('centers').doc(user.center).get();
              if (centerSnap.exists) centerName = centerSnap.data().name;
            } catch (_) { /* center lookup optional */ }
          }

          // Alert all platform admins
          for (const adminEmail of adminEmails) {
            await sendAdminInactivityAlert({
              adminEmail,
              studentName,
              studentEmail: user.email,
              daysMissed,
              centerName,
            });
          }

          // Alert center manager if applicable
          if (user.center) {
            try {
              const managerSnap = await db.collection('users')
                .where('role', '==', 'center_manager')
                .where('center', '==', user.center)
                .limit(5)
                .get();

              for (const mgr of managerSnap.docs) {
                const mgrEmail = mgr.data().email;
                if (mgrEmail) {
                  await sendAdminInactivityAlert({
                    adminEmail:   mgrEmail,
                    studentName,
                    studentEmail: user.email,
                    daysMissed,
                    centerName,
                  });
                }
              }
            } catch (_) { /* center manager query optional */ }
          }

          await userDoc.ref.update({
            lastInactivityEmail7d: admin.firestore.FieldValue.serverTimestamp(),
          });

          notified7d++;
        }
      } catch (err) {
        errors++;
        logger.error('Inactivity check error for user', { uid: userDoc.id, err: err.message });
      }
    }
  } catch (err) {
    logger.error('Inactivity check job failed', { err: err.message });
  }

  logger.info('Inactivity check job finished', { notified3d, notified7d, errors });
}

function startInactivityCheckJob() {
  // Every day at 07:00 UTC (08:00 WAT)
  cron.schedule('0 7 * * *', () => {
    runInactivityCheck().catch(err =>
      logger.error('Inactivity check job unhandled error', { err: err.message })
    );
  }, { timezone: 'UTC' });

  logger.info('Inactivity check job scheduled (daily 07:00 UTC)');
}

module.exports = { startInactivityCheckJob, runInactivityCheck };
