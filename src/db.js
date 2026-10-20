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
  }
];

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
        .run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
migrate();

module.exports = db;
