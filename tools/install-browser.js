#!/usr/bin/env node
'use strict';
// Deploy-time browser install for page rendering and screenshots.
//
// Playwright's own `--with-deps` needs root, which the build image does not give us,
// and a failing install used to leave the app claiming rendering worked. This script
// is explicit about what it did and never fails the build: without a browser the app
// still starts, it just cannot render JavaScript-only pages.
const { spawnSync } = require('child_process');

const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || '(playwright default)';
console.log(`[browser] installing chromium (cache: ${cache})`);

let result;
try {
  result = spawnSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit', env: process.env, timeout: 240000 });
} catch (e) {
  console.warn(`[browser] install could not run: ${e.message}`);
  process.exit(0);
}

if (result.status === 0) {
  console.log('[browser] chromium installed');
} else {
  console.warn(`[browser] install failed (status ${result.status ?? 'none'}); rendering stays off until it succeeds.`);
}
process.exit(0);
