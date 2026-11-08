'use strict';
// Build the React UI during a hosting install, without slowing local work.
//
// Render runs `npm install` at the repo root; the dashboard build command is not
// guaranteed to include the frontend, so the app would fall back to the vanilla
// shell. This hook builds frontend/ only when RENDER or BUILD_FRONTEND is set,
// and never fails the install: a build error degrades to the vanilla UI instead
// of taking the whole deploy down.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'frontend');
const wanted = process.env.RENDER || process.env.BUILD_FRONTEND === '1';

if (!wanted) { console.log('[frontend] skipped (set RENDER or BUILD_FRONTEND=1 to build)'); process.exit(0); }
if (!fs.existsSync(path.join(dir, 'package.json'))) { console.log('[frontend] no frontend/package.json, skipped'); process.exit(0); }

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  const hasLock = fs.existsSync(path.join(dir, 'package-lock.json'));
  execFileSync(npm, hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
  execFileSync(npm, ['run', 'build'], { cwd: dir, stdio: 'inherit' });
  const out = path.join(dir, 'dist', 'index.html');
  console.log(fs.existsSync(out) ? '[frontend] build ok' : '[frontend] build produced no dist/index.html');
} catch (e) {
  console.warn('[frontend] build failed, serving the vanilla shell:', e.message);
}
