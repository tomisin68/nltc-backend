const admin   = require('firebase-admin');
const logger  = require('../utils/logger');
const { getWeekStart } = require('../utils/week');
const { sendInAppNotification } = require('./notificationService');

/**
 * What a referrer earns when somebody creates an account through their link.
 *
 * The app names this number on the invite card (`kReferralXp` in
 * `lib/domain/referral.dart`), but this is the only place that pays it.
 */
const REFERRAL_XP = 200;

/**
 * Credit a referrer for a signup that arrived through their link.
 *
 * Idempotent per (referrer, joiner): the receipt at
 * `users/{referrer}/referrals/{joiner}` is read and written inside the same
 * transaction, so a retried — or concurrently duplicated — on-signup call
 * cannot pay for the same account twice. The receipts also *are* the record of
 * who joined, which is what makes `referralCount` auditable rather than just a
 * number somebody once incremented.
 *
 * Streak and `lastActivityAt` are deliberately left alone. This XP is for
 * handing out a link, not for studying; extending a streak while the referrer
 * slept would make the flame on their dashboard a lie, and moving
 * `lastActivityAt` would let a well-timed signup stand in for a day's work.
 *
 * Never throws. A student's account existing matters more than somebody else's
 * bonus, so the caller can await this without guarding the signup.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} referrerUid  the account being credited
 * @param {string} joinerUid    the account that just signed up
 * @returns {Promise<boolean>}  true when XP was actually awarded
 */
async function creditReferral(db, referrerUid, joinerUid) {
  try {
    const referrerRef = db.collection('users').doc(referrerUid);
    const receiptRef  = referrerRef.collection('referrals').doc(joinerUid);

    const paid = await db.runTransaction(async (tx) => {
      const [snap, receipt] = await Promise.all([
        tx.get(referrerRef),
        tx.get(receiptRef),
      ]);
      // A referrer deleted between the signup and here, or a signup already
      // paid for. Both mean "nothing to do", not "something went wrong".
      if (!snap.exists || receipt.exists) return false;

      const profile = snap.data();

      // weeklyXp is only reset by whoever writes to it next, so a value left
      // over from a previous week has to be dropped rather than added to —
      // otherwise this bonus resurrects a dead week onto the weekly board.
      const weekStart = getWeekStart();
      const carried   = (profile.weekStart || '') === weekStart
        ? (profile.weeklyXp || 0)
        : 0;

      tx.update(referrerRef, {
        xp:            (profile.xp || 0) + REFERRAL_XP,
        weeklyXp:      carried + REFERRAL_XP,
        weekStart,
        referralCount: (profile.referralCount || 0) + 1,
        referralXp:    (profile.referralXp    || 0) + REFERRAL_XP,
      });
      tx.set(receiptRef, {
        uid:      joinerUid,
        xpEarned: REFERRAL_XP,
        joinedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return true;
    });

    if (!paid) return false;

    logger.info('Referral credited', {
      referrer: referrerUid,
      joiner:   joinerUid,
      xp:       REFERRAL_XP,
    });

    // Best-effort — the XP is banked whether or not this lands.
    await sendInAppNotification(referrerUid, {
      title:     `+${REFERRAL_XP} XP — someone joined with your link! 🎉`,
      body:      `Keep sharing it. Every friend who signs up earns you another ${REFERRAL_XP} XP.`,
      type:      'referral',
      iconEmoji: '🤝',
      data:      { url: '/student.html' },
    }).catch(() => {});

    return true;
  } catch (err) {
    logger.warn('Referral credit failed', {
      referrer: referrerUid,
      joiner:   joinerUid,
      err:      err.message,
    });
    return false;
  }
}

module.exports = { creditReferral, REFERRAL_XP };
