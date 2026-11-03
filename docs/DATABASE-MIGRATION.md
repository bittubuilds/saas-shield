# Moving production from SQLite to PostgreSQL

The app runs on SQLite by default. Setting `DATABASE_URL` switches it to
PostgreSQL; nothing else in the code changes.

This document covers the **one-time data move**. Read it fully before running
anything against production.

## What the tool guarantees

`tools/sqlite-to-postgres/index.js`

- **Read-only on the source.** It takes a `VACUUM INTO` snapshot first (a
  consistent copy that includes WAL contents) and only ever reads that snapshot.
  The live SQLite file is never opened for writing.
- **Atomic.** The whole import runs in a single PostgreSQL transaction. Any
  failure, including a failed verification, rolls everything back.
- **Idempotent.** Inserts use `ON CONFLICT DO NOTHING`, so re-running skips rows
  that already exist. By default it *refuses* to touch a database that already
  holds data (exit `3`) unless you pass `--merge`.
- **Parent-before-child ordering** derived from the schema's own foreign keys, so
  constraints are satisfied row by row instead of being disabled.
- **Verifies** row counts per table, primary-key uniqueness, every foreign key,
  and the applied migration versions. Exit `4` means verification failed and the
  target is unchanged.
- **Prints no secrets.** No connection strings, password hashes, session ids or
  email bodies. Counts, table names and check results only.

## 1. Back up first

Two independent backups, both required.

```bash
# SQLite: the tool does this automatically, but keep a copy off the server too.
node tools/sqlite-to-postgres/index.js --sqlite data/saas-shield.db \
  --pg "$STAGING_URL" --backup-dir ./backups --verify-only
sha256sum backups/saas-shield-*.db        # record this hash

# PostgreSQL side, once a target exists
pg_dump --no-owner --format=custom "$STAGING_URL" > backups/pg-before-import.dump
```

Keep the SQLite file. It is the rollback path and it is what the app returns to
the moment `DATABASE_URL` is removed.

## 2. Rehearse on a staging database

Never practise on the production database.

```bash
# 1. fresh empty database on the provider
# 2. copy a snapshot of production down to your machine (read-only copy is fine)
# 3. dry run: imports, verifies, then rolls back
node tools/sqlite-to-postgres/index.js \
  --sqlite ./saas-shield-production.db \
  --pg "$STAGING_URL" --dry-run --backup-dir ./backups

# 4. real run against staging
node tools/sqlite-to-postgres/index.js \
  --sqlite ./saas-shield-production.db \
  --pg "$STAGING_URL" --backup-dir ./backups
echo $?    # 0 = imported and verified
```

Check the report: every table should show `source == inserted` and
`verification: N/N checks passed`.

## 3. Freeze writes, then copy

Sessions, scans and crawls write constantly. Import into a quiet source.

1. In Render, scale the service to a stop (or set a maintenance window).
2. Copy the SQLite file off the instance before it is destroyed: download it from
   the instance (Render shell) or take it from your last backup.
3. Run the importer against the production PostgreSQL database using that copy.
4. Confirm exit code `0` and the verification summary.

Anything written to SQLite after step 2 is not carried over, which is why the
service must be stopped first.

## 4. Switch over

1. Render → service → Environment → add `DATABASE_URL` (the provider's
   connection string, with `?sslmode=require` when the provider asks for TLS).
2. Redeploy. On boot the log line `[db] PostgreSQL backend: host:port/db`
   confirms the switch, and `/api/health` should return `{"ok":true,...}`.
3. Sign in with an existing account, open a workspace, and check that websites,
   scans and findings are present.

## 5. Rollback

Any of these returns production to SQLite; none of them destroys PostgreSQL data.

- **Fastest:** remove `DATABASE_URL` and redeploy. The app falls back to SQLite.
- **If SQLite was wiped** by a redeploy (Render's filesystem is ephemeral): put
  the backed-up file back at `data/saas-shield.db` before the service starts, or
  restore it from the snapshot the tool printed.
- **Clean PostgreSQL slate:** `psql "$URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'`
  then re-run the importer into the empty database.
- **Restore a dump:** `pg_restore --clean --no-owner --dbname "$URL" backups/pg-before-import.dump`.

## Exit codes

| Code | Meaning | Target state |
|---|---|---|
| 0 | imported (or verified) and consistent | written / untouched (`--dry-run`, `--verify-only`) |
| 2 | bad usage | untouched |
| 3 | target already has data, `--merge` not given | untouched |
| 4 | import or verification failed | rolled back |

## Notes

- Sessions are copied by default so existing logins survive the move; use
  `--skip-sessions` to force everyone to sign in again.
- `schema_migrations` is verified, not copied: the tool creates the schema from
  the app's own migrations, so the target always matches the running code.
- The tool never writes to `DATABASE_URL` targets other than the one you pass,
  and it never reads the Render environment.

## Provider comparison (checked against vendor pricing pages, Nov 2026)

| Provider | Free storage | Free compute | Inactivity | Expiry | Verdict for this app |
|---|---|---|---|---|---|
| **Neon** | 1 GB per project | 100 CU-hours/month per project, 0.25 CU default, up to 2 CU (8 GB RAM) | compute scales to zero after ~5 min idle | none, free plan is permanent | **best fit**: no card, no expiry, limits suspend compute instead of deleting data |
| **Render Postgres** | 1 GB | shared | n/a | **expires 30 days after creation** (14-day grace, then deleted) | unsafe for production data |
| **Supabase** | 500 MB | shared, 2 projects | project **paused after ~7 days** with no activity, manual resume | none | workable but the pause breaks a live app until it is resumed |
| **Render persistent disk** | paid plans only | n/a | n/a | n/a | not free |

Re-verify limits before committing: free tiers change, and the numbers above come
from each vendor's own pricing page, not from a comparison blog.

Caveat for any free tier: this app opens a connection per process and keeps a
synchronous query bridge, so it is happy with a small compute unit. Neon's
scale-to-zero costs a short cold start on the first query after idling.
