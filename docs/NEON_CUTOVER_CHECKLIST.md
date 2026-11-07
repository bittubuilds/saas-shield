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
