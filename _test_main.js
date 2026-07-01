'use strict';
const e = require('electron');
console.log('type:', typeof e);
console.log('app:', typeof e?.app);
console.log('BrowserWindow:', typeof e?.BrowserWindow);
if (e?.app) {
  console.log('SUCCESS: Electron API works!');
  e.app.on('ready', () => { console.log('APP READY'); process.exit(0); });
} else {
  console.log('FAIL: got:', typeof e === 'string' ? e.slice(-40) : JSON.stringify(e));
  process.exit(1);
}
