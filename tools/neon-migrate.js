#!/usr/bin/env node
'use strict';
// Apply the application's migrations to a Neon database over HTTPS.
//
// Why this exists: sandboxes and some CI environments block outbound port 5432,
// and Neon speaks SQL over HTTP on 443. Same migration files, same dialect
// translation, just a different transport. Idempotent: applied versions are
// recorded in schema_migrations exactly like the server's own runner.
const { neon } = require('@neondatabase/serverless');
const { translate } = require('../src/db/dialect');
const MIGRATIONS = require('../src/db/migrations');

function splitStatements(sql) {
  const out = [];
  let cur = '';
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (!inString && ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      cur += '\n';
      continue;
    }
    if (ch === "'") inString = !inString;
    if (ch === ';' && !inString) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const sql = neon(url);
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`;
  const applied = new Set((await sql`SELECT version FROM schema_migrations`).map((r) => Number(r.version)));
  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    for (const stmt of splitStatements(m.sql)) {
      const { sql: text } = translate(stmt, []);
      if (!text) continue;
      try {
        await sql.query(text);
      } catch (e) {
        // A retry after a partial run must not be blocked by DDL that landed.
        if (!/already exists/i.test(e.message)) throw new Error(`migration ${m.version}: ${e.message}`);
      }
    }
    await sql`INSERT INTO schema_migrations (version, name, applied_at) VALUES (${m.version}, ${m.name}, ${new Date().toISOString()}) ON CONFLICT DO NOTHING`;
    count += 1;
    console.log(`applied ${m.version} ${m.name}`);
  }
  const [{ c }] = await sql`SELECT COUNT(*)::int AS c FROM schema_migrations`;
  const [{ t }] = await sql`SELECT COUNT(*)::int AS t FROM information_schema.tables WHERE table_schema='public'`;
  console.log(JSON.stringify({ newly_applied: count, migrations: c, tables: t }));
})().catch((e) => { console.error('neon-migrate failed:', e.message); process.exit(1); });
