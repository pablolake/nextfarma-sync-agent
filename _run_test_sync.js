const fs   = require('fs');
const path = require('path');
const ENV_PATH = path.join(__dirname, 'docker', 'test.env');

require('dotenv').config({ path: ENV_PATH });
process.env.LOG_LEVEL = 'debug';

// Env vars de listas que el exe guarda en su store y que debemos persistir entre ejecuciones
const LIST_VARS = [
  'LIST_COLOR_VERDE', 'LIST_COLOR_AMARILLO', 'LIST_COLOR_GRIS', 'LIST_COLOR_NEGRO',
  'LIST_NEGRA',
  'LIST_INCENTIVADOS_STAR', 'LIST_INCENTIVADOS',
  'LIST_MAX_ROTACION_A', 'LIST_MAX_ROTACION_B',
  'LIST_RESTO', 'LIST_PARADOS', 'LIST_CONSOLIDADO',
];

function persistListVars() {
  let content = fs.readFileSync(ENV_PATH, 'utf8');
  for (const key of LIST_VARS) {
    const val = process.env[key];
    if (!val) continue;
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content += `\n${key}=${val}`;
    }
  }
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

const { runSync } = require('./src/sync');
runSync({ onStep: (s) => console.log('[STEP]', JSON.stringify(s)) })
  .then(r => {
    persistListVars();
    console.log('=== RESULTADO ===');
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  })
  .catch(e => { console.error('ERROR:', e); process.exit(1); });
