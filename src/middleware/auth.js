const { getAuth, getDb } = require('../../config/firebase');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  try {
    const token = header.split('Bearer ')[1];
    req.user = await getAuth().verifyIdToken(token);
    req.userData = {};
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Loads req.userData from Firestore — only called by requireAdmin/requireSuperAdmin.
async function loadUserData(req) {
  if (req.userData && req.userData._loaded) return;
  const snap = await getDb().collection('users').doc(req.user.uid).get();
  req.userData = snap.exists ? { ...snap.data(), _loaded: true } : { _loaded: true };
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    try {
      await loadUserData(req);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    const role = req.userData?.role;
    if (role !== 'admin' && role !== 'super_admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

async function requireSuperAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    try {
      await loadUserData(req);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    const role = req.userData?.role;
    if (role !== 'super_admin') {
      return res.status(403).json({ error: 'Super admin access required' });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin, requireSuperAdmin };
