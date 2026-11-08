#!/usr/bin/env node
'use strict';
// Snapshot the database. Safe to run against a live server: SQLite uses VACUUM INTO
// and PostgreSQL reads committed rows only.
const backup = require('../src/db/backup');

const keep = Number(process.env.DB_BACKUP_KEEP || 7);
const result = backup.createBackup({ label: 'manual' });
const pruned = backup.pruneBackups({ keep });
console.log(JSON.stringify({ ...result, pruned }, null, 2));
