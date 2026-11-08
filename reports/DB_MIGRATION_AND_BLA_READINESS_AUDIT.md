# SaaS Shield — Database Migration Safety + BLA Integration Readiness Audit

**Date:** 7 November 2026
**Branch:** `feat/db-durability`
**Commit:** `cb8d395` (`feat: integrate SaaS Shield modules and fix evidence freshness`)
**Working tree at start of audit:** clean (0 entries). No commit, push, merge or deploy was made during this audit.
**Author scope:** read-only inspection, isolated local test runs, one new untracked report file.

Status vocabulary used below: **VERIFIED** (observed in this session), **NOT VERIFIED** (no evidence obtained), **BLOCKED** (access or authorisation missing).

---

## 1. Executive Summary

- The migration system is **sound by construction**: one transaction per migration, an applied-version table, an advisory lock for concurrent PostgreSQL starters, and a shared DDL source translated per dialect. 13 migrations exist (versions **1–13**, 1-based).
- **Correction to the brief:** the pending set is **8, 9, 10, 11, 12 and 13** — six migrations, not five. Version 13 (`ai-report-incremental`) is part of the same unapplied range.
- Neon currently sits at **version 7, 27 tables** (read-only check, §4). A fresh SQLite database after all 13 migrations has **41 tables and 82 indexes**. The 14-table difference matches exactly the objects created by versions 8–13, so Neon holds **none** of the new tables. That makes 8–13 cheap and low-lock: every ALTER targets a table created inside the same range.
- Backups work and are verified locally on both backends, but the default destination lives next to the SQLite file, which on Render is **ephemeral storage**. A backup that does not survive a deploy is not a backup. **BLOCKED** on persistent storage.
- Render → Neon runtime connectivity is **UNVERIFIED**. No Render credential exists in this environment (§6).
- BLA is real, MIT-licensed, actively developed (`bla-agents` 3.1.0, 2688 stars, pushed 7 Nov 2026) and technically compatible with this repo's Node runtime. It is a CLI/MCP-first tool with **no published library API contract**, so integration must shell out to an isolated worker, not import it.
- **Decision: NOT READY — FIX BLOCKERS FIRST.** Details in §16.

---

## 2. Current Repository Branch and Commit

| Fact | Value | Status |
| --- | --- | --- |
| Branch | `feat/db-durability` | VERIFIED |
| HEAD | `cb8d395` | VERIFIED |
| Remote | `https://github.com/bittubuilds/saas-shield.git` (no embedded credentials) | VERIFIED |
| Working tree | clean before the audit; one new untracked file after (`reports/DB_MIGRATION_AND_BLA_READINESS_AUDIT.md`) | VERIFIED |

---

## 3. Migration 8–13 Detailed Audit

### 3.1 The runner

`src/db/migrate.js`

| Property | Implementation | Evidence |
| --- | --- | --- |
| Version tracking | `schema_migrations(version INTEGER PRIMARY KEY, name, applied_at)` created by `bootstrap()` | `migrate.js:18-24` |
| Duplicate execution | applied-set read, then a **second** in-transaction existence check before DDL | `migrate.js:43-53` |
| Transactionality | `BEGIN` … `COMMIT` per migration, `ROLLBACK` on throw | `migrate.js:46-59` |
| Concurrency | `pg_advisory_xact_lock(21842, 7)` inside the same transaction when `lock: true`; SQLite uses `BEGIN IMMEDIATE` | `migrate.js:13-14, 50` |
| Partial failure | Rolls back the single migration; `schema_migrations` gains no row → next boot retries the same version | `migrate.js:56-58` |
| Idempotent bootstrap race | `CREATE TABLE IF NOT EXISTS` retried once on duplicate-key | `migrate.js:24-33` |

Consequence: **a half-applied migration is not a reachable state** for versions 8–13, because every statement of a version lives in one transaction on both backends. SQLite DDL is transactional; PostgreSQL DDL is transactional. Both verified by the durability suite (§11).

### 3.2 Version numbering

`src/db/migrations.js` exports 13 entries; `version` is **1-based** while the array index is 0-based (`index 0 → version 1`). Any tooling that assumes `index == version` is off by one. Confirmed by enumerating the array.

### 3.3 Per-migration detail

| v | Name (line) | Objects | Nature | Re-runnable | Transactional | Compatible with Neon at v7 | Rollback | Lock/downtime risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 8 | `competitor-intelligence-foundation` (`migrations.js:498`) | 4 tables: `competitors`, `competitor_discoveries`, `competitor_pages`, `competitor_evidence`; 8 indexes | **Additive** | Yes — all `IF NOT EXISTS` | Yes | Yes | None (no down migrations) | None: creates only |
| 9 | `ai-intelligence-engine` (`:598`) | 4 tables: `ai_analyses`, `ai_findings`, `ai_usage`, `ai_reports`; 3 unique indexes (incl. `idx_ai_analyses_unique`, `idx_ai_findings_dedupe`, `idx_ai_reports_version`); 7 indexes | **Additive** | Yes | Yes | Yes | None | None: creates only |
| 10 | `competitor-intelligence-collection` (`:681`) | 9 `ALTER TABLE competitor_pages ADD COLUMN` (relevance_score, discovery_source, depth, final_url, title, text_content, text_chars, fetched_bytes, duplicate_of); 3 tables (`competitor_crawls`, `competitor_features`, `competitor_plans`); 2 unique + 7 indexes | **Additive** (columns only) | Columns are NOT individually idempotent; safe because the version row gates them | Yes | Yes | None | Low: `competitor_pages` is empty on Neon (created by v8 in the same run) |
| 11 | `evidence-versioning-and-ai-evidence-snapshots` (`:815`) | 8 `ALTER TABLE competitor_evidence`; table `ai_analysis_evidence`; 3 unique indexes (`idx_cev_content_unique`, `idx_cev_version_unique`, `idx_aie_dedupe`); 4 indexes; **2 UPDATE statements** (`migrate-line 867-868`: backfill `observed_at`/`last_seen_at` from `collected_at`) | **Additive + data-transforming backfill** | Yes in practice; the UPDATEs are `WHERE … IS NULL` | Yes | Yes | None | Low: table empty on Neon |
| 12 | `competitor-screenshots` (`:872`) | table `competitor_screenshots`; unique index `idx_shot_hash_unique`; 2 indexes | **Additive** | Yes | Yes | Yes | None | None |
| 13 | `ai-report-incremental` (`:915`) | 3 `ALTER TABLE ai_reports` (adds `input_hash`, `error`, `finished_at`); partial unique index `idx_ai_reports_running` (`WHERE status='running'`); index `idx_ai_reports_hash` | **Additive** | Yes | Yes | Yes | None | Low: `ai_reports` created by v9 in the same run |

**Dependency chain:** 10 → 8; 11 → 8 + 9 (`ai_analysis_evidence` references analyses); 12 → 8; 13 → 9. All satisfied inside the pending range, so the order is self-contained.

**Unique-index risk.** Three unique indexes (`idx_cev_content_unique`, `idx_cev_version_unique`, `idx_aie_dedupe`, plus `idx_ai_reports_running` in v13) would fail if pre-existing duplicate rows violated them. On Neon these tables **do not exist yet**, so the risk is nil. On any database where versions 8–12 were applied by an older build and data has since been written, v11's unique indexes must be checked for duplicates first. That path does not apply to the current production schema.

**SQLite/PostgreSQL consistency.** Both backends consume the same `migrations.js` statements; `src/db/dialect.js` translates the SQLite-flavoured DDL for PostgreSQL and documents why the remaining SQL is already portable (`dialect.js:11-14`: no `datetime()`, no `AUTOINCREMENT`, no `last_insert_rowid()`, no `json_extract`). Consistency evidence: fresh SQLite reaches 41 tables / 82 indexes / max version 13; the PostgreSQL durability suite applies the identical set and passes 16/16 (§11).

**Rollback.** No down migrations exist. The supported rollback is restore-from-backup (§5). Documented rather than implemented; adding destructive down-migrations is not recommended.

---

## 4. Production Schema Verification Status

Read-only inspection of the production Neon database over HTTPS (`@neondatabase/serverless`; port 5432 is blocked from this sandbox):

```
neon_state: {"tables":"27","migration":7}
version: PostgreSQL 18.6 on aarch64-unknown-linux-gnu
```

- **Schema state: VERIFIED** — `schema_migrations` max version **7**, 27 tables in `public`.
- Timestamp: today, 7 Nov 2026, this session. The earlier claim "Neon is at 7" is therefore independently confirmed, not inherited.
- **Pending: versions 8, 9, 10, 11, 12, 13.** No other DDL is outstanding.
- Not verified: row counts per table, index inventory, role grants. A read-only check of those is possible but was not needed for the decision above.
- Applying these migrations to Neon is a **production change** and was not performed. It requires your explicit authorisation (§14).

---

## 5. Backup / Restore Audit

`src/db/backup.js`

| Question | Finding | Evidence | Status |
| --- | --- | --- | --- |
| SQLite backup mechanism | `VACUUM INTO` — consistent, WAL-safe, does not lock out writers | `backup.js:52-54` | VERIFIED |
| WAL/SHM handling | No manual file copy, so no `-wal`/`-shm` skew is possible; `VACUUM INTO` produces a self-contained file | `backup.js:4-5` | VERIFIED |
| PostgreSQL mechanism | Logical JSONL export, one file per table, **not** `pg_dump` | `backup.js:6, 35-76` | VERIFIED |
| Restore ordering | Topological sort by foreign key dependency (`dependencyOrder`) | `backup.js:145-177` | VERIFIED |
| Verification | `verifyBackup` reads the backup back and compares row counts | `backup.js:189-221` | VERIFIED locally |
| Restore | `restoreBackup(target, {force})` | `backup.js:222` | VERIFIED locally (PG 15, SQLite) |
| Retention | `pruneBackups({ keep = 7 })` | `backup.js:116` | VERIFIED |
| Destination | `DB_BACKUP_DIR` or a `backups/` directory **next to the database file** | `backup.js:19` | VERIFIED |
| Survives Render ephemeral disk? | **No.** On Render the default path resolves inside the container filesystem, which is discarded on every deploy and restart. | `backup.js:19` | **BLOCKED** — requires `DB_BACKUP_DIR` on a mounted disk or an off-host destination |
| Restorable from a Neon dump? | Round-trip tested against local PostgreSQL only | `tests/db-durability.test.js` | **NOT VERIFIED** against Neon |

A generated file is not a restorable backup: the local suite restores into a fresh database and asserts row equality, which is what makes the local claim credible. The same test has never run against Neon.

---

## 6. Render → Neon Connectivity Audit

| Item | Finding | Evidence | Status |
| --- | --- | --- | --- |
| Pool configuration | `max: 10`, `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 10_000` | `src/db/pg-worker.js:22-27` | VERIFIED |
| SSL/TLS | No explicit `ssl` option; TLS is driven by `sslmode=require` in the connection string | `pg-worker.js:22-23` | VERIFIED |
| Endpoint type | Configured host is a **direct** `…aws.neon.tech` endpoint, not the `-pooler` endpoint | parsed from the connection string shape, value redacted | VERIFIED |
| Instance fan-out | 10 direct connections per instance; N instances → 10×N against Neon's per-endpoint limit | inference from above | **NOT VERIFIED** (limit must be read from the Neon console) |
| Startup on DB failure | Migration failure throws out of `src/db/index.js:23`; the process exits before serving | reproduced locally with an unreachable host | VERIFIED |
| Retry/backoff | None in the DB bootstrap; one attempt, fatal | `src/db/index.js:19-25`, `migrate.js:35` | VERIFIED |
| Health endpoint | `GET /api/health` runs `SELECT 1` and returns **503** when the database is down | `src/server.js:70-78` | VERIFIED |
| Health vs. reality | Accurate *after* boot, unreachable *before* boot: a DB outage at startup is a crash-loop, not a 503 | combination of the two rows above | VERIFIED |
| `DB_REQUIRE_DURABLE` | Throws at `src/server.js:67` / `src/db/durability.js:120` when storage is not durable; verified by forcing SQLite on `/tmp` in production mode → `durability check failed` then exit | `durability.js:118-124` | VERIFIED |
| Graceful shutdown | `SIGTERM`/`SIGINT` → scheduler stop, `server.close()`, `db.close()` (pool teardown), 8 s forced exit | `src/server.js:160-175`, `pg-backend.js:98` | VERIFIED |
| **Render→Neon at runtime** | **No Render credential in this environment** (no `render` CLI, no `RENDER_API_KEY`; `api.render.com` returns 401). Actual runtime connectivity is **UNVERIFIED**. | §6 note | **BLOCKED** |
| Sandbox→Neon | HTTPS query works; direct 5432 returns `ECONNREFUSED` (sandbox egress policy) | this session | VERIFIED, and **not** evidence about Render |

No degraded "healthy without a database" mode was introduced. None exists today: the process dies instead, which is the safer failure but produces crash-loops on Render.

---

## 7. BLA License and Source Audit

Source: `https://github.com/qybaihe/bla` (inspected via GitHub API and raw README/package.json on 7 Nov 2026).

| Item | Finding | Status |
| --- | --- | --- |
| Licence | **MIT** (`LICENSE`, `package.json: license: MIT`) | VERIFIED |
| Attribution | MIT requires the copyright notice and permission text be retained in distributions; a "built with BLA" credit is not legally required but is expected by the project's own guidance | VERIFIED |
| Package | `bla-agents` **v3.1.0**, `"type": "module"`, published on npm | VERIFIED |
| Binaries | `bla`, `bla-agents`, `bla-shield` | VERIFIED |
| Node requirement | `engines: ^22.23.4 || >=24.0.0` | VERIFIED |
| This repo's requirement | `>=22.5.0` (`package.json`) — so a Node 22.5–22.23 host satisfies SaaS Shield but **not** BLA | VERIFIED |
| Local runtime | Node **v24.22.1** — satisfies BLA | VERIFIED |
| Dependencies | `@babel/parser`, `@babel/traverse`, `@babel/generator`, `@babel/types` — pure JS, no native build step | VERIFIED |
| Activity | 2688 stars, 355 forks, last push 7 Nov 2026, not archived | VERIFIED |
| Interface surface | CLI stages `audit · protect · verify · defend` (+ `harden`, `benchmark`, `setup` for MCP) | VERIFIED |
| Library API | **No documented programmatic API contract.** The project exposes CLI and MCP tooling (`docs/cli-and-mcp.md`), not a stable `require('bla-agents')` surface | VERIFIED absence; treat import-based integration as unsupported |
| Upstream tests | `npm test` / `test:watch` scripts exist; CI workflow present | NOT VERIFIED (not executed here; no clone) |

### Defensive model

Three layers, per the upstream README:

- **Poison** — plant format-valid canaries, honey metadata and decoy control flow that read as genuine evidence.
- **Exhaust** — push artifacts past a reverse-engineering agent's documented budgets (header sizes, nesting depth, interface inventories, PCAP JSON, fuse sentinels).
- **Hallucinate** — leave the analyser with truncated inventories, redaction failures and ambiguous rabbit holes while **runtime behaviour stays equivalent**.

This raises the cost of automated analysis. It does **not** make reverse engineering impossible, and any claim that it does would be false. Upstream reports empirical budget failures against their own red-team harness on commodity hardware, and explicitly disclaims sessions in Ghidra/Frida/LLDB/Rizin/JADX that they did not run.

---

## 8. BLA Supported Formats and Limitations

| Format | Canary | Budget trip | Empirical status upstream |
| --- | :---: | :---: | --- |
| JavaScript / TypeScript | ✓ | ✓ semantic budgets | verified in-process |
| Electron `.asar` | ✓ | ✓ 16 MiB header | verified |
| Electron fuses | ✓ | ✓ >32 sentinels | verified |
| WebAssembly | ✓ | ✓ export decoys | verified (needs Wabt for empirical probe) |
| Python / `.pyc` | ✓ | ✓ | designed-for only |
| SQLite | ✓ | ✓ column eval | verified on Node 24 |
| Safetensors / GGUF | ✓ | ✓ nesting >32 | verified |
| Go buildinfo | ✓ | ✓ >1 MiB | verified |
| Flutter / Dart pool | ✓ | ✓ | verified (projected) |
| Erlang BEAM | ✓ | ✓ | verified |
| EVM bytecode | ✓ | ✓ → 4 MiB | verified (approach) |
| PCAP | ✓ | ✓ tshark JSON >8 MiB | verified with tshark |
| NVIDIA PTX | ✓ | entry flood | benchmark only |
| DEX / IL2CPP / bplist / .NET / JVM / ZIP | ✓ | format-specific | **designed-for, not verified** |
| Firmware / SPIR-V / CUDA fatbin / AMD GPU | — | — | **skipped upstream** |

**Relevant to SaaS Shield:** the artifacts a Shield Protect customer would submit are most likely JavaScript bundles, WASM, Python packages or Electron apps — all in the verified tier. Anything in the "designed-for" tier must be surfaced to the user as unverified, and the "skipped" tier must be rejected rather than accepted optimistically.

**Resource profile.** Upstream deliberately inflates artifacts (examples: ASAR header → 16.9 MiB, WASM → 6.56 MiB, EVM → 4 MiB). Peak memory scales with artifact size plus Babel ASTs for JS inputs. On a 512 MB Render instance this must run in a separate process with explicit limits, never inline in the API process.

---

## 9. Shield Protect Integration Architecture

Design only. Nothing was implemented, and no production path was touched.

```
Client (existing frontend, unchanged)
   │  POST /api/workspaces/:w/protect/jobs  (artifact metadata + upload reference)
   ▼
Shield Protect API  (existing Express app, existing auth + workspace guard)
   │  validate type/size → create protect_job row (queued) → enqueue
   ▼
Isolated BLA worker  (separate process, own Node 24 runtime, own cgroup)
   │  temp dir per job → `bla harden <dir>` → parse result → verify stage
   ▼
protect_jobs.status = completed | failed(reason)  +  result metadata + verify report
```

**Non-negotiable properties**

1. **Process isolation.** The worker is a separate OS process (or container), spawned per job with `maxBuffer`, a hard wall-clock timeout and a memory ceiling. A BLA crash must surface as a failed job, never as an API restart.
2. **No shell interpolation.** `spawn('bla', ['harden', dir], { shell: false })` with an argv array; the artifact path is generated, never client-supplied.
3. **Bounded input.** Allow-list of extensions and MIME types from §8; a explicit byte cap (suggest 64 MB) and a decompressed-size cap to stop zip bombs.
4. **Per-job temp directory** created with `fs.mkdtemp` on a path that is not served, deleted in a `finally`, with a reaper for orphans older than the job TTL.
5. **Path traversal defence.** Store artifacts under an opaque id, resolve `realpath` and reject anything outside the job root; never derive a path from the uploaded filename.
6. **Internal authentication.** The API signs the job payload (HMAC over job id + artifact digest, short TTL) and the worker rejects unsigned work. No public port on the worker.
7. **Workspace isolation.** `protect_jobs` carries `workspace_id`; every read goes through the existing `requireWorkspaceRoute()` guard. Artifacts and results are private files, never public URLs.
8. **Status and failure reporting.** `queued → running → completed | failed | cancelled`, with an error code (`unsupported_format`, `too_large`, `timeout`, `worker_crash`, `verify_failed`) and a human-readable reason that reaches the existing UI as text.
9. **Metadata only.** Store: job id, workspace, artifact digest, size, format, stage timings, verify summary, and the output artifact reference. Never store BLA's internal decoys or the client's source listings.
10. **Honest copy.** The result screen must say the artifact was hardened against automated analysis *attempts* with a measured verification outcome — never "cannot be reverse engineered".

**Minimum viable implementation** for the current infrastructure: a `protect_jobs` table, one worker script invoked via `child_process.spawn` on the same host, a 5-minute timeout, a 64 MB cap, JS/WASM/Python only, and a result screen that reports the raw verify outcome. Anything beyond that (queue service, autoscaling workers, per-tenant quota) waits until the Node 24 requirement and persistent disk are settled on Render.

---

## 10. Security Risks

| # | Risk | Impact | Mitigation | Status |
| --- | --- | --- | --- | --- |
| 1 | Backups written to ephemeral storage | Total loss of backups on deploy | `DB_BACKUP_DIR` on persistent disk or off-host | Open (blocker) |
| 2 | No DB retry at startup | Crash-loop on transient Neon outage | bounded retry with backoff before fatal exit | Open |
| 3 | Direct (non-pooled) Neon endpoint + 10 conn/instance | Connection exhaustion if scaled | use `-pooler` host | Open |
| 4 | Uploaded artifacts processed by a third-party tool | RCE surface via malformed input | separate process, no shell, size caps, temp dirs, no network in worker | Designed, not built |
| 5 | BLA output stored on ephemeral disk | Protected artifact lost after deploy | persistent object storage | Open (blocker) |
| 6 | Migration 8–13 unapplied on Neon | Deployed app would attempt 6 migrations at boot, with no rollback path | apply during a controlled window with a verified backup first | Open (blocker) |
| 7 | Secrets hygiene | previous exposure of a GitHub token in `.git/config` | remote URL cleaned; token still needs revocation by the owner | **Partially resolved — pending owner revocation** |

---

## 11. Test Results

All commands run locally in this session. No test was skipped or mocked to make it pass.

| Command | Total | Pass | Fail | Skipped | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| `npm test` (`node --test tests/*.test.js`) | 309 | 305 | 0 | 4 | 4 skips are PostgreSQL-only cases |
| `node --test tests/db-durability.test.js` (SQLite) | 16 | 13 | 0 | 3 | PG-gated cases skipped |
| `TEST_DATABASE_URL=postgres://…/verify_durability node --test tests/db-durability.test.js` | 16 | 16 | 0 | 0 | real PG 15: backup, restore, savepoint, two-process migration |
| `TEST_DATABASE_URL=… node --test tests/postgres.integration.test.js` | 1 | 1 | 0 | 0 | fresh database created for the run |
| `node --test tests/e2e-integration.test.js` ×3 | 10 each | 10 | 0 | 0 | three consecutive runs, all green |
| Fresh-schema probe (SQLite) | — | — | — | — | 41 tables, 82 indexes, max version 13 |

The intermittent zero-findings E2E failure did **not** reproduce today (0 of 3). It remains **unproven**: historically 1 in 30 before the evidence-freshness fix and 0 in 30 after, which is suggestive, not conclusive.

---

## 12. Issues Found

1. **Migration range in the brief is off by one.** Pending versions are 8–13, six migrations. Version 13 (`ai-report-incremental`) would be missed by an "8–12" plan. (`migrations.js:915`)
2. **Version field is 1-based while the array is 0-based.** Any script that maps index to version will be wrong. (`migrations.js`, enumeration evidence above)
3. **Backups default to ephemeral storage on Render.** (`backup.js:19`)
4. **No retry/backoff on DB startup; a transient Neon error exits the process.** (`src/db/index.js:19-25`)
5. **Direct Neon endpoint with a 10-connection pool per instance.** (`pg-worker.js:22-27`)
6. **Node version floor mismatch for BLA:** repo allows `>=22.5.0`, BLA needs `^22.23.4 || >=24`. A Render instance pinned to an in-between Node version would break the worker. (`package.json` both sides)
7. **No programmatic BLA API contract.** CLI/MCP only, so integration must be process-based.

---

## 13. Fixes Applied

None to application code, migrations, tests or configuration. The only file created is this report. The deliberate reason: every issue in §12 that could be "fixed" changes production behaviour or migration history, which the brief forbids without separate authorisation.

---

## 14. Blockers Requiring User Access

| Blocker | What is missing | What unblocks it |
| --- | --- | --- |
| Render runtime verification | Render API key or log access (no `render` CLI, no `RENDER_API_KEY`; `api.render.com` → 401) | a Render API key, or you running the connectivity check from the Render shell |
| Production migration 8–13 | Explicit authorisation; Neon reachable over HTTPS but DDL is a production change | your go-ahead, after a verified backup (§5) |
| Durable backups | A persistent disk or object-storage destination | a `DB_BACKUP_DIR` pointing at durable storage |
| Neon connection ceiling | The endpoint's connection limit | read it in the Neon console (Settings → Compute) |
| GitHub token revocation | Owner action at github.com/settings/applications | revoke the OAuth grant; the remote URL is already clean |
| BLA upstream test run | A local clone plus `npm ci` (≈2.9 MB repo, Babel deps) | authorisation to clone; it is a third-party dependency, not this repo |

---

## 15. Exact Next Steps

1. Read the Neon connection limit, then decide direct vs `-pooler` endpoint. If Render runs more than one instance, use `-pooler`.
2. Set `DB_BACKUP_DIR` to durable storage and take a verified backup of Neon **before** any migration.
3. Apply migrations 8–13 in one controlled boot (`DB_REQUIRE_DURABLE=true`), then re-run the read-only check: expect max version 13 and 41 tables.
4. Add bounded retry with backoff around the DB bootstrap (3 attempts, 2/4/8 s) so a transient outage does not crash-loop; keep the fatal exit afterwards.
5. Pin the worker runtime to Node ≥24 and run BLA as a spawned process behind the Shield Protect API, per §9, starting with JS/WASM/Python only.
6. Verify the intermittent E2E zero-findings path with instrumentation (`E2E_DEBUG=1` dumping packet size and post-validation finding count) before claiming it resolved.
7. Revoke the exposed GitHub OAuth grant.

---

## 16. Deployment Readiness Decision

**NOT READY — FIX BLOCKERS FIRST.**

Grounds: production migrations 8–13 are unapplied and unauthorised; backups land on ephemeral storage; DB bootstrap has no retry; Render→Neon connectivity is unverified because no Render credential exists here; and Shield Protect has no implemented worker.

What is genuinely ready: the migration runner is transactional, locked and idempotent; the migration set is self-contained and low-lock against the current Neon schema; backup/restore is verified on SQLite and PostgreSQL locally; the health endpoint reports database failure honestly at runtime; `DB_REQUIRE_DURABLE` refuses ephemeral SQLite in production; and BLA is a credible, MIT-licensed dependency with a real, documented format tier.
