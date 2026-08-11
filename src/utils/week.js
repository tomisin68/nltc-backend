/**
 * The ISO date (YYYY-MM-DD) of the most recent Monday, in UTC.
 *
 * Weekly XP is never reset by a scheduled job — whoever next writes to a
 * student's counter compares this against the stored `weekStart` and starts
 * from zero when it has moved on. That makes the week boundary a contract
 * between every writer rather than a detail of any one of them, so it lives
 * here: two writers disagreeing about where Monday is would silently carry a
 * dead week's XP into the live board.
 *
 * @param {Date} [now]  overridable for tests
 * @returns {string}
 */
function getWeekStart(now = new Date()) {
  const day      = now.getUTCDay();           // 0=Sun … 6=Sat
  const daysBack = day === 0 ? 6 : day - 1;
  const monday   = new Date(now);
  monday.setUTCDate(now.getUTCDate() - daysBack);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10);
}

module.exports = { getWeekStart };
