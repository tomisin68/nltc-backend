const { getAuth, getDb } = require('../../config/firebase');

/**
 * Verifies the Firebase ID token and loads the user's Firestore document.
 * Sets req.user  = decoded token claims
 *     req.userData = Firestore user document data (or {} if not found)
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  try {
    const token = header.split('Bearer ')[1];
    req.user = await getAuth().verifyIdToken(token);
    const snap = await getDb().collection('users').doc(req.user.uid).get();
    req.userData = snap.exists ? snap.data() : {};
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Requires role === 'admin' or 'super_admin' (checked against Firestore user doc).
 */
async function requireAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    const role = req.userData?.role;
    if (role !== 'admin' && role !== 'super_admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

/**
 * Requires role === 'super_admin' only.
 */
async function requireSuperAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    const role = req.userData?.role;
    if (role !== 'super_admin') {
      return res.status(403).json({ error: 'Super admin access required' });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin, requireSuperAdmin };
