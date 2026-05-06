const express    = require('express');
const { getDb }  = require('../../config/firebase');
const router     = express.Router();

router.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'nltc-backend', timestamp: new Date().toISOString() });
});

// Temporary diagnostic route — reveals Firestore query errors to aid debugging
// Hit: GET /api/health/diag
router.get('/diag', async (req, res) => {
  const results = {};
  const db = getDb();

  // 1. Simple document read
  try {
    await db.collection('users').limit(1).get();
    results.users_list = 'ok';
  } catch (e) { results.users_list = e.message; }

  // 2. Leaderboard query (orderBy xp)
  try {
    await db.collection('users').orderBy('xp', 'desc').limit(5).get();
    results.leaderboard = 'ok';
  } catch (e) { results.leaderboard = e.message; }

  // 3. Rank count query (compound filter + count)
  try {
    await db.collection('users').where('role', '==', 'student').where('xp', '>', 0).count().get();
    results.rank_count = 'ok';
  } catch (e) { results.rank_count = e.message; }

  // 4. Schedule query
  try {
    await db.collection('schedule').where('scheduledAt', '>=', new Date()).orderBy('scheduledAt', 'asc').limit(3).get();
    results.schedule = 'ok';
  } catch (e) { results.schedule = e.message; }

  // 5. Notifications subcollection (use a dummy uid — no docs is fine)
  try {
    await db.collection('users').doc('diag-test').collection('notifications').orderBy('createdAt', 'desc').limit(1).get();
    results.notifications_sub = 'ok';
  } catch (e) { results.notifications_sub = e.message; }

  const allOk = Object.values(results).every(v => v === 'ok');
  res.status(allOk ? 200 : 500).json({ allOk, results });
});

module.exports = router;