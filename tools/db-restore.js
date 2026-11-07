#!/usr/bin/env node
'use strict';
// Restore a verified backup. Refuses to touch a populated database without --force.
const fs = require('fs');
const path = require('path');
const backup = require('../src/db/backup');
const config = require('../src/config');

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const force = args.includes('--force');
const swap = args.includes('--swap');

if (!target) {
  console.error('usage: node tools/db-restore.js <backup-path> [--force] [--swap]');
  process.exit(2);
}

const check = backup.verifyBackup(target);
if (!check.ok) {
  console.error(JSON.stringify({ ok: false, stage: 'verify', check }, null, 2));
  process.exit(1);
}

if (swap) {
  // Stop the server first: the running process holds this file open. We copy the
  // snapshot over the live path and leave a timestamped copy of the old file so a
  // bad restore is reversible.
  const dest = path.resolve(config.databaseFile);
  const aside = `${dest}.replaced-${Date.now()}`;
  if (fs.existsSync(dest)) fs.copyFileSync(dest, aside);
  fs.copyFileSync(path.resolve(target), dest);
  console.log(JSON.stringify({ ok: true, stage: 'swap', restored_from: path.resolve(target), replaced_previous: aside }, null, 2));
  process.exit(0);
}

const result = backup.restoreBackup(target, { force });
console.log(JSON.stringify({ verify: check, restore: result }, null, 2));
process.exit(result.ok ? 0 : 1);
