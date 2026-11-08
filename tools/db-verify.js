#!/usr/bin/env node
'use strict';
const backup = require('../src/db/backup');
const target = process.argv[2];
const out = target ? backup.verifyBackup(target) : { backups: backup.listBackups(), live_row_counts: backup.rowCounts() };
console.log(JSON.stringify(out, null, 2));
process.exit(target && !out.ok ? 1 : 0);
