const express          = require('express');
const { body }         = require('express-validator');
const { requireAuth }  = require('../middleware/auth');
const { validate }     = require('../middleware/validate');
const { agoraLimiter } = require('../middleware/rateLimiter');
const { generateRtcToken } = require('../services/agoraService');
const asyncHandler     = require('../utils/asyncHandler');
const logger           = require('../utils/logger');
const router           = express.Router();

router.post('/token', agoraLimiter, requireAuth,
  [
    body('channelName').notEmpty().trim().matches(/^[a-zA-Z0-9_-]+$/).withMessage('channelName must be alphanumeric'),
    body('role').optional().isIn(['audience','host']).withMessage('role must be audience or host'),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { channelName, role = 'audience' } = req.body;
    if (role === 'host' && !req.user.admin && !req.user.teacher) {
      return res.status(403).json({ error: 'Only teachers can request a host token' });
    }
    const result = generateRtcToken(channelName, req.user.uid, role);
    logger.info('Agora token issued', { uid: req.user.uid, channelName, role });
    res.json({ success: true, ...result });
  })
);

module.exports = router;