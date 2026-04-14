const { getAuth } = require('../../config/firebase');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  try {
    const decoded = await getAuth().verifyIdToken(header.split('Bearer ')[1]);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

module.exports = { requireAuth, requireAdmin };