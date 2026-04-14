const { RtcTokenBuilder, RtcRole } = require('agora-token');

const APP_ID          = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;
const EXPIRY_SECONDS  = parseInt(process.env.AGORA_TOKEN_EXPIRY || '3600', 10);

function generateRtcToken(channelName, uid, role = 'audience') {
  if (!APP_ID || !APP_CERTIFICATE) throw new Error('Missing Agora env vars');
  if (!channelName) throw new Error('channelName is required');

  const numericUid   = uidToUint32(uid);
  const agoraRole    = role === 'host' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
  const expireTime   = Math.floor(Date.now() / 1000) + EXPIRY_SECONDS;

  const token = RtcTokenBuilder.buildTokenWithUid(
    APP_ID, APP_CERTIFICATE, channelName, numericUid, agoraRole, expireTime
  );

  return { token, channelName, uid: numericUid, appId: APP_ID, expiresAt: expireTime * 1000 };
}

function uidToUint32(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash || 1;
}

module.exports = { generateRtcToken };