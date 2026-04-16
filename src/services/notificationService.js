const admin  = require('firebase-admin');
const { getDb } = require('../../config/firebase');

/**
 * Write a single in-app notification to a user's notifications subcollection.
 */
async function sendInAppNotification(uid, { title, body, type, data, iconEmoji }) {
  const db = getDb();
  await db.collection('users').doc(uid).collection('notifications').add({
    title,
    body,
    type,
    data:      data      || {},
    iconEmoji: iconEmoji || '🔔',
    read:      false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Broadcast an in-app notification to multiple users.
 *
 * filter: 'all' | 'pro' | 'free' | 'elite'
 *   'all'   → all documents in users collection (students)
 *   others  → filtered by plan field
 */
async function broadcastInAppNotification({ filter, title, body, type, data, iconEmoji }) {
  const db = getDb();
  let q = db.collection('users');
  if (filter === 'pro')   q = q.where('plan', '==', 'pro');
  if (filter === 'free')  q = q.where('plan', '==', 'free');
  if (filter === 'elite') q = q.where('plan', '==', 'elite');
  // 'all' → no extra filter

  const snap = await q.get();

  // Firestore batch has a 500-operation limit; chunk as needed
  const CHUNK = 490;
  const docs  = snap.docs;

  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = db.batch();
    docs.slice(i, i + CHUNK).forEach(d => {
      const ref = d.ref.collection('notifications').doc();
      batch.set(ref, {
        title,
        body,
        type,
        data:      data      || {},
        iconEmoji: iconEmoji || '🔔',
        read:      false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
  }
}

/**
 * Send an FCM multicast push notification to an array of tokens.
 * Tokens are batched in groups of 500 (FCM limit).
 * Stale/invalid tokens are cleaned up asynchronously.
 *
 * Returns { sent, total }
 */
async function sendPushToTokens(tokens, { title, body, data, imageUrl }) {
  if (!tokens || !tokens.length) return { sent: 0, total: 0 };

  const batches = [];
  for (let i = 0; i < tokens.length; i += 500) {
    batches.push(tokens.slice(i, i + 500));
  }

  let totalSent    = 0;
  const staleTokens = [];

  for (const batch of batches) {
    const message = {
      tokens: batch,
      notification: {
        title,
        body,
        ...(imageUrl && { imageUrl }),
      },
      data: data || {},
      webpush: {
        notification: {
          icon:               '/icon-192.png',
          badge:              '/badge-72.png',
          requireInteraction: false,
        },
        fcmOptions: { link: data?.url || '/' },
      },
      apns: {
        payload: { aps: { badge: 1, sound: 'default' } },
      },
    };

    try {
      const result = await admin.messaging().sendEachForMulticast(message);
      totalSent += result.successCount;

      result.responses.forEach((resp, idx) => {
        if (
          !resp.success &&
          resp.error?.code === 'messaging/invalid-registration-token'
        ) {
          staleTokens.push(batch[idx]);
        }
      });
    } catch (e) {
      console.error('FCM batch error:', e.message);
    }
  }

  // Fire-and-forget stale token cleanup
  if (staleTokens.length) {
    cleanupStaleTokens(staleTokens).catch(e =>
      console.error('FCM token cleanup error:', e.message)
    );
  }

  return { sent: totalSent, total: tokens.length };
}

/**
 * Remove invalid tokens from user documents in Firestore.
 * `array-contains-any` supports up to 10 values per query.
 */
async function cleanupStaleTokens(staleTokens) {
  const db      = getDb();
  const unique  = [...new Set(staleTokens)];
  const CHUNK   = 10; // Firestore array-contains-any limit

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const snap  = await db
      .collection('users')
      .where('fcmTokens', 'array-contains-any', chunk)
      .get();

    if (snap.empty) continue;
    const batch = db.batch();
    snap.forEach(d => {
      const filtered = (d.data().fcmTokens || []).filter(t => !unique.includes(t));
      batch.update(d.ref, { fcmTokens: filtered });
    });
    await batch.commit();
  }
}

module.exports = {
  sendInAppNotification,
  broadcastInAppNotification,
  sendPushToTokens,
};
