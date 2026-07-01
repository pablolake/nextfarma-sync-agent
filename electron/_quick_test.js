const e = require('electron');
console.log('TYPE:', typeof e);
if (typeof e === 'object' && e !== null) {
  console.log('KEYS:', Object.keys(e).slice(0,8).join(','));
  console.log('SUCCESS: app is', typeof e.app);
} else {
  console.log('FAIL: got string/other:', String(e).slice(0,100));
}
process.exit(0);
