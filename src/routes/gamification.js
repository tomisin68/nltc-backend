const express        = require('express');
const { body, query }= require('express-validator');
const { requireAuth }= require('../middleware/auth');
const { validate }   = require('../middleware/validate');
const asyncHandler   = require('../utils/asyncHandler');
const logger         = require('../utils/logger');
const { getDb }      = require('../../config/firebase');
const admin          = require('firebase-admin');
const router         = express.Router();

router.use(requireAuth);

// XP rewards
const XP = { watch_lesson:15, complete_cbt:30, join_live:50, daily_streak:10, score_90_plus:20 };

function xpToLevel(xp) {
  const level = Math.floor(xp/500)+1;
  return { level, nextLevelXP: level*500, prevLevelXP: (level-1)*500 };
}

function isSameDay(a,b) { return a.toDateString()===b.toDateString(); }
function isYesterday(d) { const y=new Date(); y.setDate(y.getDate()-1); return isSameDay(d,y); }

async function awardXP(uid, action, meta={}) {
  const db=getDb(), userRef=db.collection('users').doc(uid);
  const snap=await userRef.get();
  if (!snap.exists) throw new Error('User not found');
  const profile=snap.data();
  let xpEarned = XP[action]||0;
  if (action==='complete_cbt' && meta.score>=90) xpEarned += XP.score_90_plus;
  const last = profile.lastActivityAt?.toDate?.() || null;
  const now = new Date();
  let streak = profile.streak||0;
  if (last) {
    if (isSameDay(last,now)) {} // no change
    else if (isYesterday(last)) { streak++; xpEarned+=XP.daily_streak; }
    else streak=1;
  } else { streak=1; }
  const newXP=(profile.xp||0)+xpEarned;
  await userRef.update({ xp:newXP, streak, lastActivityAt:admin.firestore.FieldValue.serverTimestamp() });
  const {level} = xpToLevel(newXP);
  return { newXP, xpEarned, newStreak:streak, level };
}

router.post('/xp',
  [body('action').isIn(['watch_lesson','complete_cbt','join_live','daily_streak']).withMessage('Invalid action'), body('meta').optional().isObject()],
  validate,
  asyncHandler(async (req,res) => {
    const result = await awardXP(req.user.uid, req.body.action, req.body.meta||{});
    logger.info('XP awarded', { uid:req.user.uid, action:req.body.action, xpEarned:result.xpEarned });
    res.json({ success:true, ...result });
  })
);

router.post('/cbt-session',
  [
    body('subject').notEmpty().trim(),
    body('score').isFloat({min:0,max:100}),
    body('correct').isInt({min:0}),
    body('total').isInt({min:1}),
    body('topic').optional().trim(),
  ],
  validate,
  asyncHandler(async (req,res) => {
    const db=getDb();
    const sessRef=db.collection('cbtSessions').doc();
    await sessRef.set({ userId:req.user.uid, ...req.body, createdAt:admin.firestore.FieldValue.serverTimestamp() });
    const result = await awardXP(req.user.uid,'complete_cbt',{score:req.body.score});
    res.status(201).json({ success:true, sessionId:sessRef.id, ...result });
  })
);

router.get('/leaderboard',
  [query('limit').optional().isInt({min:1,max:50})],
  validate,
  asyncHandler(async (req,res) => {
    const db=getDb(), limit=parseInt(req.query.limit||'20');
    const snap=await db.collection('users').orderBy('xp','desc').limit(limit).get();
    const board=snap.docs.map((d,i)=>({ rank:i+1, uid:d.id, firstName:d.data().firstName||'', lastName:d.data().lastName||'', state:d.data().state||'—', xp:d.data().xp||0, streak:d.data().streak||0 }));
    const myRank=board.findIndex(s=>s.uid===req.user.uid);
    res.json({ success:true, leaderboard:board, myRank:myRank>=0?myRank+1:null });
  })
);

router.get('/rank', asyncHandler(async (req,res) => {
  const db=getDb();
  const snap=await db.collection('users').doc(req.user.uid).get();
  if (!snap.exists) return res.status(404).json({error:'User not found'});
  const myXP=snap.data().xp||0;
  const above=await db.collection('users').where('xp','>',myXP).get();
  res.json({ success:true, rank:above.size+1 });
}));

module.exports = router;