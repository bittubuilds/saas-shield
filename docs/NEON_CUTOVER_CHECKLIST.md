# Neon PostgreSQL cutover checklist

Status: prepared and locally verified. **No production change has been made.**

Product decision recorded: the 2–3 trial accounts from friends carry no business value,
so nothing is migrated. The new database starts empty. Old SQLite files stay on disk
untouched as a rollback artifact until the deployment is verified.

## What is already true

| Item | Evidence |
|---|---|
| Neon project exists | `sweet-shape-29779616`, org Bittu, `aws-ap-southeast-1`, branch `main`, database `neondb`, PostgreSQL 18.6 |
| Schema applied | migrations 1–7 present in `schema_migrations` (verified over HTTPS), 27 tables |
| Database is clean | `users = 0`, `websites = 0` |
| App works on PostgreSQL | full e2e against local PostgreSQL 15 via `DATABASE_URL`: signup 201, signin 200, 2 websites 201, automatic pair scan `completed`, report 200 with body |
| Survives restart | after SIGTERM and a fresh process: signin 200, websites 2, scans 1, completed 1 |
| Health reports durability | `/api/health` → `backend: postgres`, `durable: true`, `migration: 7` |

## Known limitation before cutover

Outbound TCP 5432 is blocked inside the agent sandbox (`Network is unreachable`), and
Neon's HTTP endpoint only speaks the serverless driver. So the *app's own* `pg` adapter
has not been tested against Neon, only against local PostgreSQL with identical
configuration. The first real app-to-Neon connection happens on Render. That is the
gate below that cannot be closed from here.

## Cutover steps

1. **Freeze writes (optional, 2 min).** Note the current SQLite row counts for the
   record; they are not being migrated.
2. **Set the Render environment variable.** Dashboard → saas-shield → Environment →
   add `DATABASE_URL` with the Neon connection string (direct host, `sslmode=require`).
   Do not commit it, do not paste it in chat. This needs explicit owner approval.
3. **Deploy.** First boot runs migrations automatically; Neon is already at 7 so
   nothing changes.
4. **Health gate.** `GET /api/health` must return `database.backend: "postgres"`,
   `durable: true`, `migration: 7`, `error: null`. If `durable` is false or the backend
   is `sqlite`, stop and roll back.
5. **Functional gate.** With a fresh account: signup → add website → add comparison
   (scan starts automatically) → scan reaches `completed` → report exports. Refresh the
   page; data must still be there.
6. **Restart gate.** Render → Manual Deploy → Restart. Sign in again; websites, scans
   and report must survive. Confirm `/api/health` still reports `durable: true`.
7. **Watch.** Check logs for `[db] PostgreSQL backend` and absence of migration errors.

## Verification gates that must pass before calling it done

- [ ] health shows postgres + durable
- [ ] fresh signup and signin
- [ ] scan completed, not merely queued
- [ ] report reopens after a restart
- [ ] no secret appears in logs or the repo

## Rollback

1. Remove the `DATABASE_URL` variable on Render (or set it empty) and redeploy.
2. The app falls back to SQLite at `DATABASE_FILE`, which is ephemeral on the free
   plan: you return to the pre-cutover behaviour, not to the old rows.
3. Local SQLite backups (`data/saas-shield.db` and any snapshots from
   `npm run db:backup`) are untouched and remain the only copy of the trial data.
4. Neon keeps whatever the new deployment wrote; it is not deleted by a rollback.

Rollback is safe because the cutover adds no schema changes beyond what migrations
already define, and nothing in the old SQLite is mutated.

## Explicitly not doing

- No copying of trial users, websites, scans, results or reports into Neon.
- No schema reset: `schema_migrations` stays intact so future migrations apply cleanly.
- No deletion of SQLite files.
- No merge of `feat/db-durability` without approval.

## One-deployment reality check

A single Render deploy cannot prove both storage modes, because the backend is chosen
by whether `DATABASE_URL` exists in that environment at boot. There is no in-process
stage that shows SQLite and then switches.

Safest sequence with exactly one production deploy:

1. Prove the new code on SQLite **locally** (`npm test` plus `npm start`), and prove it
   on PostgreSQL **locally** (`tools/e2e-postgres.js`) - both already done and recorded.
2. Set `DATABASE_URL` **before** the single deploy, together with `DB_REQUIRE_DURABLE=true`.
   That flag makes the process refuse to start on non-durable storage instead of quietly
   running on an empty container database.
3. Deploy once. Gate A then either passes immediately or the service fails loudly at
   boot instead of serving an empty app.

Trade-off, stated plainly: with `DB_REQUIRE_DURABLE=true` a bad connection string becomes
a failed deploy rather than a page that loads with no data. If you prefer a rolling check,
leave the flag unset and rely on `/api/health` reporting `durable: true`; the cost is that
a misconfiguration looks healthy until someone notices empty tables.

Rollback is not "remove DATABASE_URL". On this plan that returns to an ephemeral SQLite
file, which is empty after the next deploy. Real rollback: `tools/db-restore.js` from a
verified logical backup, or a Neon branch/time-travel restore.

## Verified backup and recovery (free tier only)

Verified from Neon's documentation on 2026-11-04, not assumed: **Free plan instant
restore / PITR history window is up to 6 hours** (Launch 7 days, Scale 30 days).
There is no traditional nightly snapshot on Free.

Practical schedule that uses only what Free actually provides:

| Layer | What | Command | Free? |
|---|---|---|---|
| 1 | Neon PITR, 6h window | restore via console or `neon branches create --parent main --timestamp <ISO>` | yes |
| 2 | Manual pre-change snapshot | create a branch before risky operations | yes, counts toward 0.5 GB storage |
| 3 | App-level logical backup | `node tools/db-backup.js` | yes, writes locally |

Layer 3 must run somewhere durable (workstation or CI). On Render the filesystem is
ephemeral, so a backup written there dies with the container. A GitHub Action that
runs `db-backup.js` on a schedule and uploads the artifact is the documented option,
but it is **not set up and not verified**; treat it as future work.

### Restore drills (executed 2026-11-07, SQLite)

```
seed 1 row -> db-backup.js -> delete row -> restore --swap -> row count 1, 27 tables, migration 7
```
`--swap` moves the live file and its `-wal`/`-shm` sidecars aside, copies the
snapshot, opens it and counts tables, and only then reports success. Leaving a stale
WAL behind would replay the deleted rows back on top of the restore.
