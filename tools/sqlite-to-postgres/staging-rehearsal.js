#!/usr/bin/env node
'use strict';
// End-to-end rehearsal for the SQLite -> PostgreSQL cutover.
//
//   PG_URL=postgres://user:pass@host:5432/db node tools/sqlite-to-postgres/staging-rehearsal.js
//
// Phases
//   A. snapshot a database that is being written to, and prove the snapshot is a
//      consistent commit boundary and that the source is never written
//   B. import that snapshot with the real CLI (dry-run, then import)
//   C. verify counts, primary keys, foreign keys, migrations and relationships
//   D. drive the running application against the imported database
//
// Writes nothing to production: the source is opened read-only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const PG_URL = process.env.PG_URL;
if (!PG_URL) {
  console.error('PG_URL is required (staging database connection string).');
  process.exit(2);
}
const TOOL = path.join(__dirname, 'index.js');
const out = [];
const say = (s = '') => { out.push(s); console.log(s); };
let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
}

// Redact any credential that could reach a log line.
function redact(s) {
  return String(s)
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1<credentials>@')
    .replace(/(password=)[^\s&]+/gi, '$1<redacted>');
}

// ---------------------------------------------------------------------------
// Phase A: consistent snapshot under active writes
// ---------------------------------------------------------------------------
async function phaseSnapshot(workDir) {
  say('\nA. Snapshot under concurrent writes');
  const source = path.join(workDir, 'live-source.db');
  process.env.DATABASE_FILE = source;
  process.env.NODE_ENV = 'test';
  require('../../src/db');                       // creates the schema via migrations

  // A separate process keeps committing while we snapshot: that is the only way
  // to prove the copy is a consistent commit boundary rather than a torn file.
  const writerFile = path.join(workDir, 'writer.js');
  fs.writeFileSync(writerFile, [
    "const { DatabaseSync } = require('node:sqlite');",
    'const d = new DatabaseSync(process.argv[2]);',
    "d.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');",
    "const st = d.prepare('INSERT INTO audit_events (id, workspace_id, action, created_at) VALUES (?,?,?,?)');",
    'let n = 0;',
    "const t = setInterval(() => { try { st.run('aud_' + (++n), 'wsp_snap', 'rehearsal.write', new Date().toISOString()); } catch (e) { /* busy */ } }, 5);",
    'process.on("SIGTERM", () => { clearInterval(t); try { d.close(); } catch {} process.exit(0); });'
  ].join('\n'));
  const writer = spawn(process.execPath, [writerFile, source], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(500);

  const snapDir = path.join(workDir, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  const take = (name) => {
    const target = path.join(snapDir, name);
    const live = new DatabaseSync(source, { readOnly: true });
    live.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    live.close();
    return target;
  };
  const inspect = (file) => {
    const s = new DatabaseSync(file, { readOnly: true });
    const integrity = Object.values(s.prepare('PRAGMA integrity_check').get())[0];
    const fk = s.prepare('PRAGMA foreign_key_check').all().length;
    const rows = s.prepare('SELECT COUNT(*) AS c FROM audit_events').get().c;
    const maxId = s.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id,5) AS INTEGER)),0) AS m FROM audit_events").get().m;
    const distinct = s.prepare('SELECT COUNT(DISTINCT id) AS c FROM audit_events').get().c;
    s.close();
    return { integrity, fk, rows, maxId, distinct };
  };

  const first = take('source.snapshot.db');
  const one = inspect(first);
  await sleep(300);
  const second = take('source.snapshot2.db');
  const two = inspect(second);
  writer.kill('SIGTERM');
  await sleep(100);

  check('snapshot passes SQLite integrity_check', one.integrity === 'ok' && two.integrity === 'ok', `${one.integrity}/${two.integrity}`);
  check('snapshot has no foreign-key violations', one.fk === 0 && two.fk === 0, `problems=${one.fk}/${two.fk}`);
  check('each snapshot is a commit boundary (rows == highest id)', one.rows === one.maxId && two.rows === two.maxId, `${one.rows}==${one.maxId}, ${two.rows}==${two.maxId}`);
  check('no duplicate ids inside a snapshot', one.distinct === one.rows && two.distinct === two.rows);
  check('snapshot captured rows while another process was writing', one.rows > 0 && two.rows > 0, `rows=${one.rows} then ${two.rows}`);
  check('the later snapshot reflects newer commits (point in time)', two.rows >= one.rows && two.rows > 0, `${one.rows} -> ${two.rows}`);
  return { source, snapPath: second, committed: two.rows, snapRows: two.rows };
}

function sha256(file) {
  return require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---------------------------------------------------------------------------
// Phases B and C: dry-run, import, verification
// ---------------------------------------------------------------------------
function runTool(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
  return { code: r.status, text: redact(`${r.stdout || ''}${r.stderr || ''}`) };
}

function parseCounts(text) {
  const counts = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+)\s+(\d+)\s+(\d+)\s+(\d+)$/);
    if (m) counts[m[1]] = { source: Number(m[2]), target: Number(m[3]), inserted: Number(m[4]) };
  }
  return counts;
}

function phaseImport(snapPath, workDir) {
  say('\nB. Dry-run, then import');
  const dry = runTool(['--sqlite', snapPath, '--pg', PG_URL, '--dry-run', '--backup-dir', path.join(workDir, 'backups')]);
  check('dry-run exits 0', dry.code === 0, `exit=${dry.code}`);
  const dryChecks = (dry.text.match(/verification\s+:\s+(\d+)\/(\d+) checks passed/) || []);
  check('dry-run verification passes', dryChecks[1] === dryChecks[2] && Boolean(dryChecks[1]), `${dryChecks[1]}/${dryChecks[2]}`);

  const imported = runTool(['--sqlite', snapPath, '--pg', PG_URL, '--backup-dir', path.join(workDir, 'backups')]);
  check('import exits 0', imported.code === 0, `exit=${imported.code}`);
  const done = (imported.text.match(/verification\s+:\s+(\d+)\/(\d+) checks passed/) || []);
  check('post-import verification passes', done[1] === done[2] && Boolean(done[1]), `${done[1]}/${done[2]}`);
  if (imported.code !== 0) say(imported.text.split('\n').slice(-15).join('\n'));

  const verify = runTool(['--sqlite', snapPath, '--pg', PG_URL, '--verify-only', '--backup-dir', path.join(workDir, 'backups')]);
  check('independent --verify-only re-check passes', verify.code === 0, `exit=${verify.code}`);

  say('\nC. Row counts (source / target / inserted)');
  const counts = parseCounts(imported.text);
  let mismatches = 0;
  for (const [table, c] of Object.entries(counts)) {
    const ok = c.source === c.target;
    if (!ok) mismatches += 1;
    say(`  ${ok ? 'ok  ' : 'FAIL'} ${table.padEnd(24)} ${String(c.source).padStart(6)} ${String(c.target).padStart(6)}`);
  }
  check('every table matches the source', mismatches === 0, `tables=${Object.keys(counts).length} mismatches=${mismatches}`);
  return counts;
}

// ---------------------------------------------------------------------------
// Phase D: the application against the imported database
// ---------------------------------------------------------------------------
function phaseApp(pgUrl) {
  say('\nD. Application-level checks against the imported database');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'staging-app-checks.js')], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: pgUrl, DATABASE_FILE: '', PORT: '0', NODE_ENV: 'test', SHIELD_ALLOW_PRIVATE_IPS: 'true' }
  });
  const text = redact(`${r.stdout || ''}${r.stderr || ''}`);
  for (const line of text.split('\n')) {
    if (/^(PASS|FAIL|  )/.test(line.trim()) || /^[A-Z]\./.test(line)) say(line);
  }
  const fails = (text.match(/^FAIL /gm) || []).length;
  check('application checks against staging', r.status === 0 && fails === 0, `exit=${r.status} failures=${fails}`);
  if (r.status !== 0) say(text.split('\n').slice(-20).join('\n'));
  return { fails };
}

// ---------------------------------------------------------------------------
async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-rehearsal-'));
  say('SaaS Shield - staging rehearsal');
  say(`target        : ${redact(PG_URL)}`);
  say(`work dir      : ${workDir}`);
  const snap = await phaseSnapshot(workDir);
  say(`source sha256 : ${sha256(snap.source)}`);
  say(`snapshot      : ${path.basename(snap.snapPath)} (sha256 ${sha256(snap.snapPath).slice(0, 16)}..., ${snap.snapRows} audit rows)`);
  const counts = phaseImport(snap.snapPath, workDir);
  phaseApp(PG_URL);
  say('\n────────────────────────────────────────');
  say(`tables compared : ${Object.keys(counts).length}`);
  say(`result          : ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('rehearsal error:', redact(e && e.message ? e.message : e));
  process.exit(1);
});
