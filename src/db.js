'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const dbFile = path.resolve(config.databaseFile);
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

// ---------------------------------------------------------------------------
// Versioned migrations. Each entry runs once, in order, recorded in
// schema_migrations. Add new entries to the end; never edit applied ones.
// ---------------------------------------------------------------------------
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial-schema',
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE memberships (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      );

      CREATE TABLE websites (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('original','comparison')),
        submitted_url TEXT NOT NULL,
        normalized_domain TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','active','paused','error')),
        crawl_status TEXT NOT NULL DEFAULT 'not_crawled'
                CHECK (crawl_status IN ('not_crawled','queued','crawling','crawled','failed')),
        crawl_error TEXT,
        accessible_page_count INTEGER NOT NULL DEFAULT 0,
        last_scanned_at TEXT,
        label TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, kind, normalized_domain)
      );
      CREATE INDEX idx_websites_ws ON websites(workspace_id);

      CREATE TABLE pages (
        id TEXT PRIMARY KEY,
        website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        url TEXT NOT NULL,              -- final resolved URL
        submitted_url TEXT,
        canonical_url TEXT,
        title TEXT,
        text_content TEXT NOT NULL DEFAULT '',
        meta_description TEXT,
        content_hash TEXT NOT NULL,
        http_status INTEGER,
        fetched_at TEXT NOT NULL,
        UNIQUE (website_id, url)
      );
      CREATE INDEX idx_pages_website ON pages(website_id);
      CREATE INDEX idx_pages_ws ON pages(workspace_id);
      CREATE INDEX idx_pages_hash ON pages(website_id, content_hash);

      CREATE TABLE scans (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        original_website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
        comparison_website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','completed','failed','cancelled')),
        params TEXT NOT NULL DEFAULT '{}',
        pages_compared INTEGER,
        findings INTEGER,
        error TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX idx_scans_ws ON scans(workspace_id);
      CREATE INDEX idx_scans_status ON scans(status);

      CREATE TABLE results (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        latest_scan_id TEXT,
        original_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        comparison_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        original_url TEXT NOT NULL,
        comparison_url TEXT NOT NULL,
        match_type TEXT NOT NULL CHECK (match_type IN ('long_passage','partial_passage','phrase','low_similarity')),
        jaccard_score REAL NOT NULL,
        cosine_score REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','in_review','confirmed','dismissed')),
        dedupe_key TEXT NOT NULL,
        first_observed_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, dedupe_key)
      );
      CREATE INDEX idx_results_ws ON results(workspace_id);
      CREATE INDEX idx_results_status ON results(workspace_id, status);
      CREATE INDEX idx_results_scan ON results(scan_id);
      CREATE INDEX idx_results_scores ON results(workspace_id, jaccard_score);

      CREATE TABLE passages (
        id TEXT PRIMARY KEY,
        result_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
        original_text TEXT NOT NULL,
        comparison_text TEXT NOT NULL,
        word_count INTEGER NOT NULL,
        score REAL NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_passages_result ON passages(result_id);

      CREATE TABLE evidence (
        id TEXT PRIMARY KEY,
        result_id TEXT NOT NULL UNIQUE REFERENCES results(id) ON DELETE CASCADE,
        capture_status TEXT NOT NULL DEFAULT 'captured'
              CHECK (capture_status IN ('captured','partial','failed')),
        capture_error TEXT,
        original_excerpt TEXT NOT NULL,
        comparison_excerpt TEXT NOT NULL,
        original_hash TEXT NOT NULL,
        comparison_hash TEXT NOT NULL,
        screenshot_ref TEXT,
        captured_at TEXT NOT NULL
      );

      CREATE TABLE review_events (
        id TEXT PRIMARY KEY,
        result_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        user_id TEXT,
        from_status TEXT,
        to_status TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_review_events_result ON review_events(result_id);

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        user_id TEXT,
        action TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_audit_ws ON audit_events(workspace_id, created_at);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,            -- sha256 of the session token
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);
    `
  },
  {
    version: 2,
    name: 'email-verification-and-oauth',
    sql: `
      ALTER TABLE users ADD COLUMN email_verified_at TEXT;
      ALTER TABLE users ADD COLUMN email_verified_source TEXT;

      -- Only a SHA-256 of the emailed token is stored. The raw token exists
      -- solely in the email that was sent to the address being verified.
      CREATE TABLE email_verification_tokens (
        id TEXT PRIMARY KEY,                       -- sha256(raw token)
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT,                            -- sha256(6-digit code), optional entry path
        purpose TEXT NOT NULL DEFAULT 'signup',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        requested_ip TEXT,
        invalidated_reason TEXT
      );
      CREATE INDEX idx_evt_user ON email_verification_tokens(user_id, created_at);
      CREATE INDEX idx_evt_expiry ON email_verification_tokens(expires_at);

      CREATE TABLE oauth_accounts (
        provider TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_login_at TEXT,
        PRIMARY KEY (provider, provider_user_id)
      );
      CREATE INDEX idx_oauth_user ON oauth_accounts(user_id);

      -- Auth attempts, used for persistent rate limiting and for auditability.
      -- Never stores passwords, tokens, or codes.
      CREATE TABLE auth_events (
        id TEXT PRIMARY KEY,
        email TEXT,
        user_id TEXT,
        ip TEXT,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_auth_events_email ON auth_events(email, created_at);
      CREATE INDEX idx_auth_events_ip ON auth_events(ip, created_at);
      CREATE INDEX idx_auth_events_action ON auth_events(action, created_at);
    `
  },
  {
    version: 3,
    name: 'monitoring-snapshots-changes-alerts',
    sql: `
      ALTER TABLE websites ADD COLUMN monitor_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE websites ADD COLUMN frequency_hours INTEGER NOT NULL DEFAULT 24;
      ALTER TABLE websites ADD COLUMN last_checked_at TEXT;
      ALTER TABLE websites ADD COLUMN next_check_at TEXT;
      ALTER TABLE websites ADD COLUMN baseline_at TEXT;
      ALTER TABLE websites ADD COLUMN baseline_status TEXT NOT NULL DEFAULT 'none'
              CHECK (baseline_status IN ('none','created','failed'));
      ALTER TABLE websites ADD COLUMN baseline_error TEXT;

      -- Pages a user chose to watch for a site (pricing, signup, home, ...).
      CREATE TABLE monitored_pages (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        normalized_url TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'other'
             CHECK (role IN ('homepage','pricing','signup','features','docs','blog','changelog','other')),
        label TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_checked_at TEXT,
        next_check_at TEXT,
        last_status TEXT NOT NULL DEFAULT 'pending'
             CHECK (last_status IN ('pending','ok','unchanged','changed','failed','skipped')),
        last_error TEXT,
        last_change_at TEXT,
        baseline_snapshot_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (website_id, normalized_url)
      );
      CREATE INDEX idx_monpages_ws ON monitored_pages(workspace_id);
      CREATE INDEX idx_monpages_due ON monitored_pages(enabled, next_check_at);

      -- Immutable snapshot of one page at one point in time.
      CREATE TABLE snapshots (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
        monitored_page_id TEXT NOT NULL REFERENCES monitored_pages(id) ON DELETE CASCADE,
        requested_url TEXT NOT NULL,
        final_url TEXT NOT NULL,
        http_status INTEGER,
        fetched_at TEXT NOT NULL,
        title TEXT,
        meta_description TEXT,
        headings TEXT NOT NULL DEFAULT '[]',      -- JSON: [{level,text}]
        links TEXT NOT NULL DEFAULT '[]',          -- JSON: [{href,text}]
        images TEXT NOT NULL DEFAULT '[]',         -- JSON: [{src,alt}]
        ctas TEXT NOT NULL DEFAULT '[]',           -- JSON: [text]
        forms TEXT NOT NULL DEFAULT '[]',          -- JSON: [{action,fields[],submit}]
        pricing TEXT NOT NULL DEFAULT '[]',        -- JSON: [{name,amount,currency,interval,limits[],confidence}]
        structure TEXT NOT NULL DEFAULT '{}',      -- JSON: {sections,...}
        text_normalized TEXT NOT NULL,
        text_raw TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL DEFAULT 0,
        redirect_chain TEXT NOT NULL DEFAULT '[]',
        capture_status TEXT NOT NULL DEFAULT 'ok'
              CHECK (capture_status IN ('ok','empty','partial')),
        capture_error TEXT,
        is_baseline INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_snapshots_page ON snapshots(monitored_page_id, fetched_at);
      CREATE INDEX idx_snapshots_ws ON snapshots(workspace_id, fetched_at);
      CREATE INDEX idx_snapshots_hash ON snapshots(monitored_page_id, content_hash);

      -- Persistent changelog. One row per detected, deduplicated change.
      CREATE TABLE changes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
        monitored_page_id TEXT NOT NULL REFERENCES monitored_pages(id) ON DELETE CASCADE,
        page_role TEXT NOT NULL,
        page_url TEXT NOT NULL,
        previous_snapshot_id TEXT REFERENCES snapshots(id) ON DELETE SET NULL,
        current_snapshot_id TEXT REFERENCES snapshots(id) ON DELETE SET NULL,
        detected_at TEXT NOT NULL,
        category TEXT NOT NULL
             CHECK (category IN ('pricing','signup','headings','copy','sections','links','cta','images','title','meta','other')),
        summary TEXT NOT NULL,
        significance REAL NOT NULL DEFAULT 0,
        confidence TEXT NOT NULL DEFAULT 'high'
             CHECK (confidence IN ('high','medium','low')),
        significance_label TEXT NOT NULL DEFAULT 'minor',
        previous_value TEXT,
        current_value TEXT,
        evidence TEXT NOT NULL DEFAULT '{}',       -- JSON diff details
        dedupe_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open'
             CHECK (status IN ('open','acknowledged','dismissed')),
        reviewed_by TEXT,
        reviewed_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, dedupe_key)
      );
      CREATE INDEX idx_changes_ws ON changes(workspace_id, detected_at);
      CREATE INDEX idx_changes_page ON changes(monitored_page_id, detected_at);
      CREATE INDEX idx_changes_status ON changes(workspace_id, status);
      CREATE INDEX idx_changes_category ON changes(workspace_id, category);

      -- Actionable alert raised from a change.
      CREATE TABLE alerts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        change_id TEXT NOT NULL UNIQUE REFERENCES changes(id) ON DELETE CASCADE,
        website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
        severity TEXT NOT NULL DEFAULT 'info'
             CHECK (severity IN ('critical','high','normal','info')),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unread'
             CHECK (status IN ('unread','read','dismissed')),
        dedupe_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT,
        UNIQUE (workspace_id, dedupe_key)
      );
      CREATE INDEX idx_alerts_ws ON alerts(workspace_id, created_at);
      CREATE INDEX idx_alerts_status ON alerts(workspace_id, status);

      -- Delivery attempts per channel, with bounded retry state.
      CREATE TABLE alert_deliveries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        alert_id TEXT REFERENCES alerts(id) ON DELETE CASCADE,
        digest_id TEXT,
        channel TEXT NOT NULL DEFAULT 'email',
        recipient TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','sent','failed','skipped')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        provider TEXT,
        provider_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        UNIQUE (channel, recipient, alert_id)
      );
      CREATE INDEX idx_deliveries_status ON alert_deliveries(status, next_attempt_at);
      CREATE INDEX idx_deliveries_ws ON alert_deliveries(workspace_id, created_at);

      CREATE TABLE digests (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        period_key TEXT NOT NULL,                  -- e.g. 2026-W44
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        change_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','sent','skipped','failed')),
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, period_key)
      );

      CREATE TABLE notification_settings (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        immediate_email INTEGER NOT NULL DEFAULT 1,
        digest_enabled INTEGER NOT NULL DEFAULT 1,
        digest_day INTEGER NOT NULL DEFAULT 1,      -- 0=Sunday .. 6=Saturday (UTC)
        digest_hour_utc INTEGER NOT NULL DEFAULT 8,
        min_severity TEXT NOT NULL DEFAULT 'high'
              CHECK (min_severity IN ('critical','high','normal','info')),
        include_empty_digest INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      -- Cross-process advisory locks so a second instance (or an overlapping
      -- scheduler tick) never double-runs checks or double-sends a digest.
      CREATE TABLE job_locks (
        name TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    version: 4,
    name: 'indexes-and-result-detail',
    sql: `
      ALTER TABLE results ADD COLUMN structural_score REAL;
      ALTER TABLE results ADD COLUMN signals TEXT;          -- JSON: per-signal breakdown
      ALTER TABLE results ADD COLUMN limitations TEXT;      -- JSON: array of caveats
      CREATE INDEX idx_results_latest_scan ON results(latest_scan_id);
      CREATE INDEX idx_results_observed ON results(workspace_id, last_observed_at);
      CREATE INDEX idx_scans_created ON scans(workspace_id, created_at);
      CREATE INDEX idx_pages_fetched ON pages(website_id, fetched_at);
    `
  },
  {
    version: 5,
    name: 'page-structure-and-digest-delivery-uniqueness',
    sql: `
      -- Store the extracted structure alongside page text so scans can compare
      -- headings/links/images/forms without re-fetching every page.
      ALTER TABLE pages ADD COLUMN structure TEXT;

      -- A digest is delivered at most once per recipient, even when the same
      -- digest is re-processed after a retry.
      CREATE UNIQUE INDEX idx_deliveries_digest_unique
        ON alert_deliveries(digest_id, recipient) WHERE digest_id IS NOT NULL;
      CREATE INDEX idx_changes_dedupe ON changes(dedupe_key);
      CREATE INDEX idx_snapshots_page_time ON snapshots(monitored_page_id, fetched_at DESC);
    `
  }
];

function nowIso() {
  return new Date().toISOString();
}

function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)')
        .run(m.version, m.name, nowIso());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
migrate();

// ---------------------------------------------------------------------------
// Data migrations that depend on configuration, applied once and recorded.
// ---------------------------------------------------------------------------
function metaGet(key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key=?').get(key);
  return row ? row.value : null;
}
function metaSet(key, value) {
  db.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?,?,?)
              ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(key, String(value), nowIso());
}

function postMigrate() {
  // Accounts that existed before email verification was introduced are marked
  // confirmed with source='migration' so real users are not locked out, and so
  // the decision stays auditable (it is not the same as a verified signup).
  if (config.auth.grandfatherExistingUsers && metaGet('auth.grandfather_v2') === null) {
    const result = db.prepare(`UPDATE users
        SET email_verified_at = COALESCE(email_verified_at, created_at),
            email_verified_source = COALESCE(email_verified_source, 'migration')
        WHERE email_verified_at IS NULL`).run();
    metaSet('auth.grandfather_v2', nowIso());
    if (result.changes > 0) {
      console.log(`[db] grandfathered ${result.changes} pre-existing account(s) as email-confirmed (source=migration)`);
    }
  }

  // Give every workspace explicit notification defaults.
  const missing = db.prepare(`SELECT w.id FROM workspaces w
      LEFT JOIN notification_settings n ON n.workspace_id = w.id
      WHERE n.workspace_id IS NULL`).all();
  for (const row of missing) {
    db.prepare(`INSERT INTO notification_settings
      (workspace_id, immediate_email, digest_enabled, digest_day, digest_hour_utc, min_severity, include_empty_digest, updated_at)
      VALUES (?,1,1,?,?, 'high',0,?)`)
      .run(row.id, config.alerts.defaultDigestDay, config.alerts.defaultDigestHourUtc, nowIso());
  }
}
postMigrate();

// Exposed so tests can build a database at an older schema version and verify
// the upgrade path for existing accounts.
db.MIGRATIONS = MIGRATIONS;

module.exports = db;
module.exports.metaGet = metaGet;
module.exports.metaSet = metaSet;
