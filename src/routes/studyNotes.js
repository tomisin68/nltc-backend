const express      = require('express');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const logger       = require('../utils/logger');
const { getDb }    = require('../../config/firebase');

const router = express.Router();

/*
 * The study-note TOPIC INDEX — the syllabus without the syllabus.
 *
 * The weekly timetable has to know every topic a student's chosen subjects
 * contain before it can lay a week out. Reading /studyNotes from the client to
 * find that out is not an option: `content` on those documents is a whole HTML
 * page — stylesheet, comparison tables, inline <svg> diagrams — and tens of
 * kilobytes each. Four hundred of them is megabytes of markup pulled down to
 * read four hundred titles, on phones metered by the megabyte.
 *
 * The Admin SDK can do what the client SDK cannot: `.select()` asks Firestore
 * for named fields only, so `content` never leaves the database. That is the
 * whole reason this endpoint exists rather than a direct read.
 */

// One category's index is a few kilobytes and changes only when an admin
// uploads a note, so it is held in memory. A cold Render instance rebuilds it
// on the first request, which is one query.
const cache = new Map(); // category → { at, topics }
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const CATEGORIES = new Set(['senior', 'junior']);

// ─── GET /api/study-notes/topics?category=senior ─────────────────────────────
// Every topic that has a study note, grouped by subject. No note bodies.
router.get('/topics', requireAuth, asyncHandler(async (req, res) => {
  const category = String(req.query.category || 'senior').toLowerCase();
  if (!CATEGORIES.has(category)) {
    return res.status(400).json({ error: "category must be 'senior' or 'junior'" });
  }

  const hit = cache.get(category);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return res.json({ category, subjects: hit.topics, cached: true });
  }

  const snap = await getDb()
    .collection('studyNotes')
    .where('category', '==', category)
    // The field mask. Without it this response is megabytes of note bodies.
    .select('subject', 'topic', 'order')
    .get();

  /* Grouped by subject here rather than on the client, because both the app and
     the website need exactly this shape and neither should have to agree
     separately on how to build it. */
  const bySubject = {};
  snap.forEach(doc => {
    const d = doc.data();
    const subject = (d.subject || '').trim();
    const topic   = (d.topic || '').trim();
    if (!subject || !topic) return;
    (bySubject[subject] = bySubject[subject] || []).push({
      id: doc.id,
      topic,
      order: typeof d.order === 'number' ? d.order : 9999,
    });
  });

  /* Sorted server-side so every client walks the topics of a subject in the same
     sequence. The timetable's promise — that no topic comes round again until
     the whole subject has been covered — is a promise about an ordering, and it
     only holds if the app and the browser agree on what that ordering is. */
  const subjects = Object.keys(bySubject).sort((a, b) => a.localeCompare(b)).map(name => ({
    subject: name,
    topics: bySubject[name].sort(
      (a, b) => a.order - b.order || a.topic.localeCompare(b.topic),
    ),
  }));

  cache.set(category, { at: Date.now(), topics: subjects });
  logger.info('Study-note topic index built', {
    category,
    subjects: subjects.length,
    topics: snap.size,
  });

  res.json({ category, subjects, cached: false });
}));

module.exports = router;
