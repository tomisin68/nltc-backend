const LEVELS = { error:0, warn:1, info:2, debug:3 };
const CURRENT = LEVELS[process.env.LOG_LEVEL] ?? (process.env.NODE_ENV==='production' ? 2 : 3);
const C = { error:'\x1b[31m', warn:'\x1b[33m', info:'\x1b[36m', debug:'\x1b[90m', reset:'\x1b[0m' };

function log(level, msg, meta={}) {
  if (LEVELS[level] > CURRENT) return;
  const ts = new Date().toISOString();
  const isProd = process.env.NODE_ENV === 'production';
  const color = isProd ? '' : (C[level]||'');
  const reset = isProd ? '' : C.reset;
  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  const line = `${color}[${ts}] [${level.toUpperCase()}] ${msg}${metaStr}${reset}`;
  level === 'error' ? console.error(line) : level === 'warn' ? console.warn(line) : console.log(line);
}

const logger = {
  error: (msg, meta) => log('error', msg, meta),
  warn:  (msg, meta) => log('warn',  msg, meta),
  info:  (msg, meta) => log('info',  msg, meta),
  debug: (msg, meta) => log('debug', msg, meta),
};
module.exports = logger;