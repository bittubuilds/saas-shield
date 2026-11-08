# Database Durability Report — Milestone 2

**Date:** 2026-11-07
**Branch:** `feat/db-durability` (not merged, not deployed)
**Base:** `main` @ `01232c6`
**Status:** durability *observability and tooling* implemented and tested. The architecture cutover itself is prepared, documented and **not executed** — it requires a managed PostgreSQL instance, which needs your credentials.

---

## 1. Why production data can be lost

Three facts combine into total data loss on every deploy:

1. `render.yaml` declares `plan: free` and **no persistent disk**. Render's free plan does not offer disks at all; the container filesystem is rebuilt from the image on every deploy, restart, crash-restart and scale event.
2. `src/config.js` defaults `DATABASE_FILE` to `path.join(__dirname, '..', 'data', 'saas-shield.db')` — a path **inside the application image**.
3. Nothing in the app noticed. `/api/health` returned `{ok: true}` because the query `SELECT 1` succeeded against a freshly created, empty database.

So the sequence is silent: deploy → new container → SQLite file created empty → migrations run → `ok: true` → every account, website, scan, finding, evidence hash and credit ledger row is gone, with no error anywhere.

This is not a theoretical risk. It is the default state of the current production deployment.

**Secondary risk:** the default path is writable in the image, so the app can *appear* healthy for weeks while each deploy resets it. Any user data collected between deploys exists only until the next one.

---

## 2. Architecture chosen

**Target: PostgreSQL via `DATABASE_URL`** (provider-agnostic; Neon or Supabase free tier both work).

Why not a Render disk: persistence requires a paid instance. That violates the free-first constraint.

Why PostgreSQL and not another file store: the adapter already exists, serves 27 tables through the same migrations and the same dialect translator, and was verified on PostgreSQL 15 in earlier milestones (migrations, atomic claims, credit concurrency across six processes). Choosing it is a configuration change, not a rewrite.

**Default behaviour is unchanged.** With no `DATABASE_URL`, SQLite still runs exactly as before. Every new guard is additive, so nothing breaks if you deploy before provisioning PostgreSQL.

What was added:

| Component | Purpose |
|---|---|
| `src/db/durability.js` | Probes the *storage*, not just connectivity. Classifies the database as durable or ephemeral (image path, temp dir, or undeclared mount) and proves writability with a real upsert. Exposed on `/api/health` and in the deploy log. |
| Startup banner | Loud warning naming the exact file path and the fix, on every boot of an ephemeral deployment. |
| `DB_REQUIRE_DURABLE=true` | Opt-in hard failure instead of a warning, for when you want a deploy to refuse to start on throwaway storage. |
| `src/db/backup.js` | SQLite: consistent snapshot via `VACUUM INTO`. PostgreSQL: logical JSONL export per table plus a manifest with row counts. Verification and retention included. |
| `tools/db-backup.js`, `db-restore.js`, `db-verify.js` | Operator CLI: `npm run db:backup`, `db:restore <path> [--force] [--swap]`, `db:verify [path]`. |
| `tools/db-copy-sqlite-to-pg.js` | One-time cutover copy of existing SQLite rows into PostgreSQL, parent-first, `ON CONFLICT DO NOTHING`, idempotent. |
| `/api/health` `database` block | `{backend, durable, writable, migration, tables, storage, note}` — no connection string, no credentials. |

---

## 3. Migration strategy (documented, not executed)

1. **Freeze writes briefly.** Stop the Render service, or accept that rows written during the copy may need a second pass (the copy is idempotent, so a second run is safe).
2. **Snapshot the live SQLite file** while it still exists: `npm run db:backup` inside the instance, or download `data/saas-shield.db` through a shell session.
3. **Provision free PostgreSQL**, obtain the connection string.
4. **Apply the schema** by starting the app once with `DATABASE_URL` set; the existing migration runner creates all 27 tables (verified: `applied 7 migration(s)` on a fresh PostgreSQL 15).
5. **Copy existing rows** with `npm run db:copy -- /path/to/saas-shield.db`. Parents are inserted before children; conflicts are ignored so re-running cannot duplicate.
6. **Verify counts** table by table against the source before switching traffic.
7. **Set `DATABASE_URL` on Render** and redeploy. Health must report `backend: postgres`, `durable: true`.
8. **Keep the SQLite snapshot** for 30 days as a rollback path.

### Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Copy runs while the app writes, so late rows are missed | Medium | Idempotent copy; run twice, compare counts, or stop writes first |
| Free PostgreSQL sleeps or hits storage limits | Medium | Provider-side; documented in the backup doc. Data survives sleep, unlike the current setup |
| New per-request latency to a remote database | Low–Medium | Connection pooling already in the worker; measure after cutover |
| Migration divergence between SQLite and PostgreSQL | Low | Single shared `migrations.js` + dialect translator; PostgreSQL applies the identical statements |
| Operator forgets to set `DATABASE_URL` and redeploys | High (that is the current state) | Startup warning, `/api/health` `durable: false`, optional `DB_REQUIRE_DURABLE=true` |
| No automated backups yet | Medium | Manual CLI implemented; scheduling is an ops task, documented below |

---

## 4. What was tested (real output)

`npm test` → **136 passed, 0 failed** (126 existing + 10 new; no existing test changed).

New suite `tests/db-durability.test.js`, all running against real files and real child processes:

```
✔ a sqlite file inside the application image is reported as not durable
✔ declaring a persistent path makes the same file durable
✔ data written by one process is readable by a different process
✔ migrations are idempotent across restarts
✔ sqlite backup captures a consistent snapshot and verifies
✔ a restore brings deleted rows back
✔ backup retention keeps the newest snapshots and prunes the rest
✔ a truncated snapshot fails verification instead of restoring silently
✔ stale scan recovery still runs after a restart
✔ the health probe never leaks the connection string
```

Restart persistence is proven with **separate OS processes**, not by re-requiring a module: process A writes, process B reads and reports the row count.

PostgreSQL, run against a real PostgreSQL 15 cluster:

```
logical backup: 27 tables, 8 rows
verify:         ok
restore --force: ok
app_meta rows:  1 → 1 (deleted, then restored)
cutover copy:   users 1, workspaces 1, memberships 1 — errors: []
```

Background recovery after restart: a scan left `running` with a 1-hour-old `started_at` was recovered to `failed` by a **fresh process** running `recoverStaleScans()` — so scan recovery does not depend on in-memory state.

---

## 5. What is NOT done

1. **No managed PostgreSQL instance provisioned.** That needs your Neon/Supabase account and the connection string. Until then production remains ephemeral.
2. **No `DATABASE_URL` set on Render.** Changing production environment is explicitly out of scope without your approval.
3. **No scheduled backups.** The CLI works; wiring a daily `npm run db:backup` (cron job, GitHub Action, or Render cron) is an ops decision, and with PostgreSQL you get point-in-time recovery from the provider anyway.
4. **No restore drill on production data.** Verified on controlled local files only.
5. **`sites` table in the copy tool's ordering list** may not exist in older databases; the tool detects `to_regclass` and reports it as skipped rather than failing. Confirmed: `skipped_tables: []` in the test.
6. **Concurrent migration across two instances is not locked.** Two instances starting simultaneously on an empty database could both attempt migrations. SQLite is single-instance by nature; for PostgreSQL this needs an advisory lock, which is a small follow-up rather than a solve-now risk.

---

## 6. Operational procedure

**Backup (SQLite):** `npm run db:backup` → writes `data/backups/sqlite-manual-<timestamp>.db` plus a manifest, prunes to `DB_BACKUP_KEEP` (default 7).

**Backup (PostgreSQL):** same command → writes a directory of `.jsonl` files plus `manifest.json`. Verify with `npm run db:verify <path>`; restore with `npm run db:restore <path> --force`.

**Recovery from a bad deploy:** stop the service, restore the newest verified snapshot, start the service, check `/api/health` reports the expected migration number.

**PostgreSQL provider backups:** Neon and Supabase both retain automatic backups on free tiers with restore-from-console. This is the primary recovery path once cut over; the CLI is the portable second line.

---

## 7. Honest assessment

The durability *problem* is well understood and the *tools to fix it* are built and tested. What has not changed is where production data actually lives — that stays ephemeral until someone provisions PostgreSQL and sets the environment variable, which requires credentials I do not have and an approval I do not have.

So: the app can now tell you it is about to lose your data, and can move the data safely when you are ready. It cannot yet make the data durable on its own.

## Post-review hardening (7 Nov)

Three defects were found reviewing this work against the code rather than the report:

1. **Concurrent migrations could crash a second instance.** `CREATE TABLE IF NOT
   EXISTS schema_migrations` races in PostgreSQL: both sessions pass the existence
   check and one fails on `pg_type`'s unique index. Bootstrap now retries once, which
   means "the other process won".
2. **Migration decisions were made before any lock existed.** The applied-set was read
   outside the transaction, so two processes starting together could both decide to
   apply migration 7. Each migration now takes `pg_advisory_xact_lock` (released by
   COMMIT) and re-checks its own version inside the transaction. SQLite uses
   `BEGIN IMMEDIATE` plus the same re-check, so the loser waits rather than duplicating.
3. **`tables` in the health payload counted migrations, not tables.** It reported 7 on a
   database with 27 tables. It now counts real tables per backend.

Proven with independent OS processes, not sequential calls: two `node` processes
migrating one fresh SQLite file and one fresh PostgreSQL database simultaneously both
exit 0, record each migration exactly once, and produce 27 tables.

## Release-candidate review (2026-11-07)

Defects found and fixed:

1. **SQLite restore could be silently undone.** `--swap` copied only the `.db` file
   and left `-wal`/`-shm` in place, so the next open replayed the old WAL over the
   restored file. Sidecars are now parked alongside the replaced file, the restore is
   verified by opening the result and counting tables, and the previous file is kept
   for rollback. Regression test added.
2. **Restore verification opened the live database.** The CLI loaded the app's db
   module (and therefore a connection) merely to verify a snapshot. The swap path now
   inspects the snapshot on its own connection.
3. **`DB_REQUIRE_DURABLE=true` behaviour is now proven**, not just documented:
   ephemeral storage exits 1 with `DB_REQUIRE_DURABLE=true and the configured
   database is not durable`; declaring `DB_PERSISTENT_PATH` starts normally with
   `durable: true`.

Test totals after the review: 139 tests, 139 pass with PostgreSQL, 138 pass + 1 skip
(the PostgreSQL-gated case) without it.
