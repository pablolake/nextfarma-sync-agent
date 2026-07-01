const fs     = require('fs');
const path   = require('path');
const EventEmitter = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(20);

const LEVELS       = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB — rota a .1 al superarlo

function currentLevel() { return LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 1; }

function getLogFile() {
  if (process.env.LOG_FILE) return path.resolve(process.cwd(), process.env.LOG_FILE);
  if (process.env.USERDATA_PATH) return path.join(process.env.USERDATA_PATH, 'sync.log');
  return null;
}

function write(level, ...args) {
  if (LEVELS[level] < currentLevel()) return;
  const ts  = new Date().toISOString();
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[36m';
  console.log(color + line + '\x1b[0m');
  const logFile = getLogFile();
  if (logFile) {
    try {
      try { if (fs.statSync(logFile).size > MAX_LOG_SIZE) fs.renameSync(logFile, logFile + '.1'); } catch {}
      fs.appendFileSync(logFile, line + '\n');
    } catch {}
  }
  emitter.emit('log', { level, ts, msg, line });
}

module.exports = {
  debug: (...a) => write('debug', ...a),
  info:  (...a) => write('info',  ...a),
  warn:  (...a) => write('warn',  ...a),
  error: (...a) => write('error', ...a),
  emitter,
};
