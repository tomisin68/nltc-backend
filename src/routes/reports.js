const express       = require('express');
const admin         = require('firebase-admin');
const { body, param, query } = require('express-validator');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate }  = require('../middleware/validate');
const asyncHandler  = require('../utils/asyncHandler');
const logger        = require('../utils/logger');
const { getDb }     = require('../../config/firebase');

const router = express.Router();

// ─── Why these live server-side ──────────────────────────────────────────────
// A chat report has to freeze the conversation as it stood when it was
// reported. Doing that from the client is not good enough for two reasons:
// the reporter can only read messages the rules let them read, and either
// party can soft-delete a message the moment they realise a report has been
// filed. The Admin SDK reads past both, and writes the snapshot somewhere
// neither participant can touch.
//
// `chatReports` and `bugReports` are admin-only by rule: students write
// through here and never read back.

const MAX_SNAPSHOT_MESSAGES = 2000;

/** Messages are chunked into a subcollection: a busy chat blows past the 1 MiB
 *  document ceiling, and a report that fails to save is a report that never
 *  happened. 200 per page keeps each page well inside the limit even with long
 *  messages. */
const SNAPSHOT_PAGE_SIZE = 200;

/** Trims a stored message down to what an investigation actually needs.
 *  Deliberately keeps `deleted` and `deletedFor`: "this was withdrawn straight
 *  after it was sent" is evidence, not noise. */
function snapshotMessage(doc) {
  const m = doc.data() || {};
  return {
    id:          doc.id,
    type:        m.type || 'text',
    text:        typeof m.text === 'string' ? m.text.slice(0, 5000) : '',
    senderId:    m.senderId || null,
    senderName:  m.senderName || null,
    timestamp:   m.timestamp || null,
    fileUrl:     m.fileUrl || m.imageUrl || null,
    fileName:    m.fileName || null,
    replyTo:     m.replyTo || null,
    deleted:     m.deleted === true,
    deletedFor:  Array.isArray(m.deletedFor) ? m.deletedFor : [],
    editedAt:    m.editedAt || null,
  };
}

// ─── POST /api/reports/chat ──────────────────────────────────────────────────
// A student reports a conversation. The whole history is copied into the
// report so the investigation is not at the mercy of what either party leaves
// standing afterwards.
//
// Body: { chatId, reason, details? }
router.post(
  '/chat',
  requireAuth,
  [
    body('chatId').isString().trim().notEmpty(),
    body('reason').isString().trim().isLength({ min: 1, max: 120 }),
    body('details').optional({ nullable: true }).isString().isLength({ max: 2000 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { chatId, reason } = req.body;
    const details = (req.body.details || '').trim();
    const db      = getDb();

    const chatSnap = await db.collection('chats').doc(chatId).get();
    if (!chatSnap.exists) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const chat    = chatSnap.data() || {};
    const members = Array.isArray(chat.members) ? chat.members : [];

    // Only somebody in the room may report it. Without this check any
    // authenticated user could name a chat id and pull its entire history
    // into a document — which is the same data leak, just with extra steps.
    if (!members.includes(req.user.uid)) {
      return res.status(403).json({ error: 'You are not a member of this conversation' });
    }

    const reporterSnap = await db.collection('users').doc(req.user.uid).get();
    const reporter     = reporterSnap.exists ? reporterSnap.data() : {};
    const reporterName = [reporter.firstName, reporter.lastName].filter(Boolean).join(' ')
      || reporter.displayName
      || reporter.email
      || 'Student';

    const reportRef = db.collection('chatReports').doc();

    await reportRef.set({
      chatId,
      chatType:      chat.type || 'dm',
      chatName:      chat.name || null,
      members,
      memberNames:   chat.memberNames || {},
      // Everyone in the room except the reporter — who the report is *about*.
      reportedUids:  members.filter(uid => uid !== req.user.uid),
      reporterUid:   req.user.uid,
      reporterName,
      reporterEmail: reporter.email || null,
      reason,
      details:       details || null,
      status:        'open',
      messageCount:  0,
      createdAt:     admin.firestore.FieldValue.serverTimestamp(),
    });

    // Page through the history oldest-first so the snapshot reads in order.
    let copied  = 0;
    let cursor  = null;
    let page    = 0;

    while (copied < MAX_SNAPSHOT_MESSAGES) {
      let q = db.collection('chats').doc(chatId).collection('messages')
        .orderBy('timestamp', 'asc')
        .limit(SNAPSHOT_PAGE_SIZE);
      if (cursor) q = q.startAfter(cursor);

      const snap = await q.get();
      if (snap.empty) break;

      await reportRef.collection('messages').doc(`page-${String(page).padStart(4, '0')}`).set({
        page,
        from:     copied,
        messages: snap.docs.map(snapshotMessage),
      });

      copied += snap.docs.length;
      cursor  = snap.docs[snap.docs.length - 1];
      page   += 1;
      if (snap.docs.length < SNAPSHOT_PAGE_SIZE) break;
    }

    await reportRef.update({
      messageCount: copied,
      // Says plainly that the snapshot stops short, so nobody reads a partial
      // history as the whole story.
      truncated:    copied >= MAX_SNAPSHOT_MESSAGES,
    });

    logger.info?.(`chat report ${reportRef.id} filed by ${req.user.uid} on chat ${chatId} (${copied} messages)`);

    res.json({ success: true, reportId: reportRef.id, messageCount: copied });
  }),
);

// ─── POST /api/reports/bug ───────────────────────────────────────────────────
// The shake-to-report path in the mobile app. Everything past `message` is
// diagnostic context the app collects itself — a bug report with no app
// version and no screen name costs more to chase than it saves.
router.post(
  '/bug',
  requireAuth,
  [
    body('message').isString().trim().isLength({ min: 1, max: 2000 }),
    body('screen').optional({ nullable: true }).isString().isLength({ max: 200 }),
    body('appVersion').optional({ nullable: true }).isString().isLength({ max: 60 }),
    body('platform').optional({ nullable: true }).isString().isLength({ max: 60 }),
    body('device').optional({ nullable: true }).isString().isLength({ max: 200 }),
    body('osVersion').optional({ nullable: true }).isString().isLength({ max: 120 }),
    body('screenshotUrl').optional({ nullable: true }).isString().isLength({ max: 1000 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const db = getDb();

    const userSnap = await db.collection('users').doc(req.user.uid).get();
    const user     = userSnap.exists ? userSnap.data() : {};

    const ref = await db.collection('bugReports').add({
      uid:           req.user.uid,
      name:          [user.firstName, user.lastName].filter(Boolean).join(' ')
                       || user.displayName || user.email || 'Student',
      email:         user.email || null,
      message:       req.body.message.trim(),
      screen:        req.body.screen || null,
      appVersion:    req.body.appVersion || null,
      platform:      req.body.platform || null,
      device:        req.body.device || null,
      osVersion:     req.body.osVersion || null,
      screenshotUrl: req.body.screenshotUrl || null,
      status:        'open',
      createdAt:     admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, reportId: ref.id });
  }),
);

// ─── GET /api/reports/chat ───────────────────────────────────────────────────
// Admin inbox. Summaries only — the message snapshot is fetched per report.
router.get(
  '/chat',
  requireAdmin,
  [query('status').optional().isIn(['open', 'reviewing', 'resolved', 'dismissed', 'all'])],
  validate,
  asyncHandler(async (req, res) => {
    const db     = getDb();
    const status = req.query.status || 'open';

    let q = db.collection('chatReports').orderBy('createdAt', 'desc').limit(200);
    if (status !== 'all') q = db.collection('chatReports')
      .where('status', '==', status)
      .orderBy('createdAt', 'desc')
      .limit(200);

    const snap = await q.get();
    res.json({ reports: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  }),
);

// ─── GET /api/reports/chat/:id/messages ──────────────────────────────────────
// The frozen conversation, flattened back into one ordered list.
router.get(
  '/chat/:id/messages',
  requireAdmin,
  [param('id').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const db   = getDb();
    const snap = await db.collection('chatReports').doc(req.params.id)
      .collection('messages').orderBy('page', 'asc').get();

    const messages = [];
    snap.docs.forEach(d => {
      const page = d.data() || {};
      if (Array.isArray(page.messages)) messages.push(...page.messages);
    });

    res.json({ messages });
  }),
);

// ─── PATCH /api/reports/chat/:id ─────────────────────────────────────────────
router.patch(
  '/chat/:id',
  requireAdmin,
  [
    param('id').isString().trim().notEmpty(),
    body('status').isIn(['open', 'reviewing', 'resolved', 'dismissed']),
    body('note').optional({ nullable: true }).isString().isLength({ max: 2000 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    await getDb().collection('chatReports').doc(req.params.id).update({
      status:     req.body.status,
      adminNote:  req.body.note || null,
      reviewedBy: req.user.uid,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  }),
);

// ─── GET /api/reports/bug ────────────────────────────────────────────────────
router.get(
  '/bug',
  requireAdmin,
  [query('status').optional().isIn(['open', 'reviewing', 'resolved', 'dismissed', 'all'])],
  validate,
  asyncHandler(async (req, res) => {
    const db     = getDb();
    const status = req.query.status || 'open';

    let q = db.collection('bugReports').orderBy('createdAt', 'desc').limit(200);
    if (status !== 'all') q = db.collection('bugReports')
      .where('status', '==', status)
      .orderBy('createdAt', 'desc')
      .limit(200);

    const snap = await q.get();
    res.json({ reports: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  }),
);

// ─── PATCH /api/reports/bug/:id ──────────────────────────────────────────────
router.patch(
  '/bug/:id',
  requireAdmin,
  [
    param('id').isString().trim().notEmpty(),
    body('status').isIn(['open', 'reviewing', 'resolved', 'dismissed']),
    body('note').optional({ nullable: true }).isString().isLength({ max: 2000 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    await getDb().collection('bugReports').doc(req.params.id).update({
      status:     req.body.status,
      adminNote:  req.body.note || null,
      reviewedBy: req.user.uid,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  }),
);

module.exports = router;
