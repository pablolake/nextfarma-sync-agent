'use strict';
// Check for ESM module hooks and loaders
const { Module } = require('module');
try {
  const { register } = require('module');
  console.log('module.register available:', typeof register);
} catch(e) { console.log('register error:', e.message.slice(0,50)); }

// Check if there are any ESM loaders by trying to use the hook API
try {
  const moduleLoader = process.binding('module_wrap');
  console.log('module_wrap binding:', typeof moduleLoader, Object.keys(moduleLoader||{}).slice(0,5));
} catch(e) { console.log('module_wrap error:', e.message.slice(0,50)); }

// Try import() with a hook-aware path
(async () => {
  // Try node: prefixed builtin to understand loader behavior
  try {
    const m = await import('node:path');
    console.log('node:path import ok');
  } catch(e) { console.log('node:path import error:', e.message.slice(0,50)); }
  
  // Check if electron:// or electron: prefix works
  for (const p of ['electron:', 'electron:app', 'node:electron']) {
    try {
      const m = await import(p);
      console.log(p, 'import ok:', typeof m, Object.keys(m||{}).slice(0,5));
    } catch(e) { console.log(p, 'error:', e.message.slice(0,60)); }
  }
  process.exit(0);
})();
