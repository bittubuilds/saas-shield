# Deploying SaaS Shield

SaaS Shield is one Node.js service. It needs a writable data store and, for
crawling, outgoing HTTPS. Node 22.5+ is required (`node:sqlite`).

Honesty note: everything below marked **verified** was actually run by the
project; everything marked **not verified** has not been executed against that
platform and should be treated as a recipe, not a guarantee.

## 1. Local development

```bash
npm ci
npm run dev            # node --watch src/server.js
npm test               # full suite, SQLite in a temp directory
```

Defaults: `PORT=3000`, SQLite at `./data/saas-shield.db`. No `.env` file is
required. `.env.example` lists every supported variable.

## 2. Docker build and run

```bash
docker build -t saas-shield:local .
docker run --rm -p 3000:3000 \
  -e PUBLIC_BASE_URL=http://localhost:3000 \
  saas-shield:local
curl -s localhost:3000/api/health
```

The image runs as UID 10001, honours `PORT`, binds `HOST=0.0.0.0`, and starts
`node src/server.js` under `tini` so SIGTERM reaches the app.

## 3. Docker with persistent SQLite

SQLite lives at `/app/data`, which is declared as a volume. Mount a named volume
so rebuilds and restarts keep data:

```bash
docker volume create shield-data
docker run -d --name shield -p 3000:3000 \
  -v shield-data:/app/data \
  -e PUBLIC_BASE_URL=https://shield.example.com \
  saas-shield:local
```

A bind mount works too: `-v "$PWD/shield-data:/app/data"`. The container user
must be able to write there (`chown -R 10001:10001 shield-data` on Linux hosts).

**Warning:** SQLite on a platform with an ephemeral filesystem (Render free,
Heroku dynos, Fly machines without a volume, any `docker run` without `-v`) is
lost on every deploy, restart or scale-down. Use PostgreSQL for production.

## 4. PostgreSQL

Set `DATABASE_URL` and the app uses PostgreSQL; leave it unset and it uses
SQLite. There is no silent fallback: if `DATABASE_URL` is set but the connection
fails, startup fails loudly rather than quietly writing to SQLite.

```bash
DATABASE_URL=postgres://user:pass@host:5432/dbname?sslmode=require npm start
```

Migrations run automatically on boot. **Verified:** the full test suite runs
against PostgreSQL 15 (`110 passed, 0 failed`), and an import from SQLite is
covered by `tools/sqlite-to-postgres` with 89/89 verification checks.

### Neon (optional provider)

```bash
DATABASE_URL=postgresql://user:pass@ep-xxxx.region.aws.neon.tech/dbname?sslmode=require
```

Use the **pooled** host for serverless/short-lived processes. The free plan
provides 1 GB storage and 100 CU-hours per project, scales compute to zero after
about five minutes idle, and does not expire. **Not verified** by this project:
the adapter has only been exercised against a local PostgreSQL 15 instance.

## 5. Render

- Existing deployment: `render.yaml` blueprint, free plan, no persistent disk.
- Free instances sleep after 15 minutes idle and have an ephemeral filesystem,
  so SQLite data is lost on redeploy. Set `DATABASE_URL` (Neon or a paid Render
  Postgres) before trusting it with real data.
- Free Render Postgres expires 30 days after creation.
- `CRON_SECRET` + an external cron job keeps scheduled checks running while the
  instance sleeps; in-process scheduling stops when the service spins down.

## 6. Railway

```bash
railway init
railway add --plugin postgresql     # provides DATABASE_URL
railway up
```
Set `PUBLIC_BASE_URL` to the generated domain, keep the service at one replica
while scheduling runs in-process, and add a volume mounted at `/app/data` if you
insist on SQLite. **Not verified.**

## 7. Fly.io

```bash
fly launch --no-deploy
fly volumes create shield_data --size 1
fly secrets set DATABASE_URL=postgres://... PUBLIC_BASE_URL=https://<app>.fly.dev
fly deploy
```
Mount the volume at `/app/data` in `fly.toml` if using SQLite, and keep
`min_machines_running = 1` if you rely on the in-process scheduler. **Not verified.**

## 8. Generic VPS (Docker Compose sketch)

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    ports: ["3000:3000"]
    environment:
      PUBLIC_BASE_URL: https://shield.example.com
      COOKIE_SECURE: "true"
    volumes: ["shield-data:/app/data"]
volumes:
  shield-data:
```
Put Caddy or nginx in front for TLS. **Not verified.**

## 9. Custom domain, HTTPS and cookies

1. Point an `A`/`AAAA` (or `CNAME`) record at the host.
2. Terminate TLS at the proxy or platform; the app speaks plain HTTP on `PORT`.
3. Set `PUBLIC_BASE_URL=https://your.domain` — it is used in verification links
   and alert emails, so a wrong value produces links that do not work.
4. Set `COOKIE_SECURE=true` behind HTTPS. Session cookies are `HttpOnly`;
   they are only marked `Secure` when this flag is on, so over plain HTTP leave
   it unset or logins will appear to fail silently.

## 10. Health checks

`GET /api/health` returns JSON with `ok`, `uptime`, `env`, and integration flags.
It does not touch the database, so it stays fast; a failing database shows up as
500s on real endpoints instead. The Docker image declares a `HEALTHCHECK` that
calls it every 30 s with a 20 s start period.

## 10b. Hardening notes

- The process writes **only** inside `/app/data`. `EMAIL_DEV_SINK` is ignored when
  `NODE_ENV=production`, so nothing is written elsewhere; `/app` itself is
  root-owned and read-only to UID 10001.
- `EXPOSE 3000` is documentation only. Change the port with `-e PORT=8080` and
  `-p 8080:8080`; no rebuild is needed.
- Running with `--read-only --tmpfs /tmp` should work given the write surface
  above, but that combination has **not been tested** here.
- The image contains no credentials: `.dockerignore` keeps `.env*`, keys and any
  `*.db` out of the build context, and the database is created on the volume at
  first start.

## 11. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` in Docker | Bind address |
| `PUBLIC_BASE_URL` | request host | Absolute base for verification and alert links |
| `DATABASE_URL` | unset | PostgreSQL when set; SQLite otherwise |
| `DATABASE_FILE` | `./data/saas-shield.db` | SQLite path (ignored when `DATABASE_URL` is set) |
| `COOKIE_SECURE` | off | Mark session cookies `Secure` (HTTPS only) |
| `AUTH_REQUIRE_EMAIL_VERIFICATION` | derived | Force verification on/off; derived from deliverability |
| `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM`, `RESEND_WEBHOOK_SECRET` | unset | Optional email |
| `SERPER_API_KEY` | unset | Optional auto-discovery; everything else works without it |
| `CRON_SECRET` | unset | External scheduler trigger `POST /api/internal/cron` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset | Optional Google sign-in |
| `SHIELD_ALLOW_PRIVATE_IPS` | off | Test only: relax SSRF guards |
| `MONITOR_USE_SITEMAP` | on | Sitemap page discovery |
| `PG_POOL_MAX`, `PG_QUERY_TIMEOUT_MS` | `10`, `30000` | PostgreSQL pool/timeouts |

## 12. Backup and restore

**PostgreSQL (recommended)**
```bash
pg_dump "$DATABASE_URL" -Fc -f shield-$(date +%F).dump    # backup
pg_restore --clean --if-exists -d "$DATABASE_URL" shield-YYYY-MM-DD.dump
```
Take backups before every deploy that runs migrations, and verify a restore into
a scratch database at least once.

**SQLite**
```bash
sqlite3 data/saas-shield.db "VACUUM INTO 'backup-$(date +%F).db'"
```
`VACUUM INTO` is safe on a live database and includes WAL contents; do not
`cp` a database that is being written to. The importer does this automatically.

## 13. Moving SQLite to PostgreSQL

`tools/sqlite-to-postgres/index.js` is a one-time, idempotent copy:

```bash
node tools/sqlite-to-postgres/index.js --sqlite ./data/saas-shield.db \
  --pg "$DATABASE_URL" --backup-dir ./backups --dry-run   # then without
```
It snapshots the source, imports in foreign-key order, and verifies row counts,
primary keys, foreign keys and migration versions. Full runbook and the
rollback (`tools/postgres-to-sqlite/reconcile.js`) are in
`docs/DATABASE-MIGRATION.md`.

## 14. Background processing: what runs inside the web process

There is no queue and no worker. Everything runs in the web process:

| Work | Trigger | Where |
|---|---|---|
| Scheduled page checks | in-process timer (`scheduler.js`), or `POST /api/internal/cron` | web process |
| Change detection, alerts, digests | inline in the check | web process |
| Website scans | `POST /workspaces/:id/scans` → background function in-process | web process |
| Auto-discovery runs | same | web process |
| Email sends | inline with the request | web process |

**What a restart affects:** a scan or discovery in progress is lost (its row stays
`queued`/`running` until the stale-scan cleanup marks it failed), a scheduled tick
that was mid-flight is retried on the next tick, and queued alert emails are
retried from `email_outbox`. Completed baselines, findings and changelog entries
are already committed and survive.

**Locking:** the scheduler uses a `job_locks` row with `INSERT … ON CONFLICT(name)
DO UPDATE … WHERE expires_at < now` and a TTL, plus an instance id, so two
processes or an overlapping tick cannot double-run checks. The statement is
portable: it was exercised on both SQLite and PostgreSQL by the test suite. On
ephemeral hosts the in-process timer stops when the instance sleeps, which is why
`CRON_SECRET` + an external cron is the recommended production setup.

**Future worker separation (design only, not implemented):** move scan/discovery
execution behind a claimed-work table (`status='queued'` → `claimed_by`,
`claimed_at`, `lease_expires`), let N worker containers poll it with the same
`job_locks`-style lease, and keep the web process read-only for job execution.
The `job_locks` table and the `scans.status` column already carry the states this
needs; no Redis is required until polling itself becomes the bottleneck.

---

## Database durability (added Milestone 2)

The free Render plan has no persistent disk, so `data/saas-shield.db` is destroyed on
every deploy. `/api/health` now reports a `database` block; `database.durable: false`
means the running instance cannot survive a redeploy.

Durable production setup:

1. Create a free PostgreSQL database (Neon or Supabase).
2. Set `DATABASE_URL` in the service environment. Migrations apply automatically on boot.
3. To keep existing SQLite data, run `npm run db:copy -- /path/to/saas-shield.db` once
   against that database (idempotent, parent-first).
4. Confirm `/api/health` shows `backend: postgres` and `durable: true`.
5. Take a snapshot before any migration: `npm run db:backup`.

Full detail: `docs/DATABASE_DURABILITY_REPORT.md`.
