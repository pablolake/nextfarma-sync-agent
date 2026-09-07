require('dotenv').config({ path: __dirname + '/docker/test.env' });
process.env.LOG_LEVEL = 'debug';
const { runSync } = require('./src/sync');
runSync({ onStep: (s) => console.log('[STEP]', JSON.stringify(s)) })
  .then(r => { console.log('=== RESULTADO ==='); console.log(JSON.stringify(r, null, 2)); process.exit(0); })
  .catch(e => { console.error('ERROR:', e); process.exit(1); });
