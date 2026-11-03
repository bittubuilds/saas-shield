# Temporary database diagnostic endpoint

`GET /api/internal/db-diagnostic` answers three questions that Render's free plan
otherwise makes hard to answer (no shell, no log access):

1. is the app actually using SQLite or PostgreSQL right now?
2. is the SQLite file present, readable and structurally intact?
3. does the directory holding it survive a restart, or is it container-local?

It exists **only while `DB_DIAGNOSTIC_SECRET` is set**, and every response is a
fixed set of facts: no rows, no queries, no paths, no credentials.

## Enabling it

Set one environment variable to a random value of **at least 32 characters**:

```
DB_DIAGNOSTIC_SECRET=<output of: openssl rand -hex 32>
```

A shorter value is treated as "not configured" and the route answers `404`, the
same as a missing secret. There is no endpoint to rotate the secret: change the
variable and redeploy.

## Calling it

```bash
curl -s -H "x-db-diagnostic-secret: $DB_DIAGNOSTIC_SECRET" \
  https://<your-host>/api/internal/db-diagnostic
```

`Authorization: Bearer <secret>` works too. Without a correct secret the response
is `404 {"error":"Not found."}` — identical to an unknown path, so the endpoint is
invisible to anyone who does not already hold the secret. The comparison is
constant-time (both sides are hashed before `timingSafeEqual`).

## Response

```json
{
  "checked_at": "2026-11-03T14:48:00.000Z",
  "backend": "sqlite",
  "connectivity": "connected",
  "sqlite": {
    "file_exists": true,
    "file_size_bytes": 118784,
    "readable": true,
    "integrity_check": "ok",
    "integrity_issues": 0
  },
  "storage": { "persistence": "ephemeral", "reason": "overlay filesystem at container root" }
}
```

| Field | Meaning |
|---|---|
| `backend` | `sqlite` or `postgres`, taken from the live database handle |
| `connectivity` | result of one `SELECT 1`; `connected` or `error` |
| `sqlite.file_exists` / `file_size_bytes` | `fs.stat` of the configured file |
| `sqlite.readable` | a read-only handle opened it successfully |
| `sqlite.integrity_check` | `PRAGMA integrity_check`: `ok`, `failed`, or `error` |
| `storage.persistence` | `ephemeral`, `persistent` or `unknown`, from `/proc/self/mounts` |

With PostgreSQL the response is the same shape but `sqlite: null` and a
`storage.reason` explaining that the database is hosted elsewhere. `DATABASE_URL`
is never returned, and no connection detail is included beyond `connectivity`.

### What it deliberately does not do

- No writes, no `VACUUM`, no backups, no schema changes, no lock acquisition.
- No error text is echoed (a failing database reports `error`, not the exception).
- No paths, emails, password hashes, tokens, cookies or SQL statements appear in
  the response; the test suite asserts each of those absences.
- `integrity_check` opens a second **read-only** handle so the running
  connection is untouched. On a very large database it is not free: call it when
  you are debugging, not in a loop.

## Removing it after verification

1. Delete `DB_DIAGNOSTIC_SECRET` from the environment. The route immediately
   returns `404` for everything, including correct requests. This alone is
   sufficient to disable it.
2. For a full removal, delete `src/routes/db-diagnostic-routes.js`, the
   `app.use('/api/internal', require('./routes/db-diagnostic-routes').router);`
   line in `src/server.js`, the `config.dbDiagnosticSecret` assignment in
   `src/config.js`, `tests/db-diagnostic.test.js`, and this file.

Step 1 is reversible and is the recommended way to switch it off while keeping
the code for a later look.
