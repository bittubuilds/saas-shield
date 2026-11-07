'use strict';
// Schema migrations, shared by both backends. Each entry records a version and
// the SQL that version introduces. PostgreSQL runs the same statements through
// the dialect translator, so the two schemas cannot drift apart.
module.exports = [
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
  },
  {
    version: 6,
    name: 'discoveries table for auto-discovery runs',
    sql: `
      CREATE TABLE IF NOT EXISTS discoveries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        original_website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','completed','failed')),
        provider TEXT,
        queries TEXT,
        found_hosts TEXT,
        created_scan_count INTEGER,
        error TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_discoveries_ws ON discoveries(workspace_id);
    `
  },
  {
    version: 7,
    name: 'email-outbox-for-send-audit-and-delivery-status',
    sql: `
      -- Every outbound email attempt, with the provider's id so a later webhook
      -- can attach real delivery status. Absence of a row would mean an email was
      -- never even attempted.
      CREATE TABLE email_outbox (
        id TEXT PRIMARY KEY,
        to_email TEXT NOT NULL,
        to_domain TEXT,
        subject TEXT,
        provider TEXT,
        provider_message_id TEXT,
        status TEXT NOT NULL,              -- sent|failed|skipped, then accepted|delivered|bounced|...
        error_code TEXT,
        error_message TEXT,
        test_sender INTEGER NOT NULL DEFAULT 0,
        context TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT,
        last_event TEXT,
        last_event_at TEXT
      );
      CREATE INDEX idx_email_outbox_created ON email_outbox(created_at DESC);
      CREATE INDEX idx_email_outbox_msg ON email_outbox(provider_message_id);
    `
  },
  {
    version: 8,
    name: 'competitor-intelligence-foundation',
    sql: `
      -- Structured competitors. A row is only created when we actually saw the
      -- site, so source_url and discovered_at are never guessed.
      CREATE TABLE IF NOT EXISTS competitors (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        discovery_id TEXT,
        website_id TEXT,
        domain TEXT NOT NULL,
        site_url TEXT NOT NULL,
        name TEXT,
        description TEXT,
        category TEXT,
        target_audience TEXT,
        positioning TEXT,
        relevance_score INTEGER,
        relevance_breakdown TEXT,
        status TEXT NOT NULL DEFAULT 'possible'
                CHECK (status IN ('verified','possible','rejected','unverifiable')),
        status_reason TEXT,
        source_url TEXT,
        discovery_source TEXT,
        discovered_at TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, domain)
      );

      CREATE INDEX IF NOT EXISTS idx_competitors_ws ON competitors(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_competitors_status ON competitors(workspace_id, status);

      -- One row per candidate per discovery run, kept even when the candidate is
      -- rejected: knowing what was considered and why is part of the evidence.
      CREATE TABLE IF NOT EXISTS competitor_discoveries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        discovery_id TEXT,
        competitor_id TEXT,
        query TEXT,
        result_url TEXT NOT NULL,
        result_host TEXT NOT NULL,
        search_rank INTEGER,
        decision TEXT NOT NULL CHECK (decision IN ('verified','possible','rejected')),
        score INTEGER,
        score_breakdown TEXT,
        reason TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cdisc_ws ON competitor_discoveries(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_cdisc_competitor ON competitor_discoveries(competitor_id);

      -- Pages we actually fetched for a competitor, with deterministic classification.
      CREATE TABLE IF NOT EXISTS competitor_pages (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        competitor_id TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        page_type TEXT NOT NULL DEFAULT 'other'
                  CHECK (page_type IN ('homepage','product','features','pricing','docs','blog','about','other')),
        classification_confidence REAL,
        classification_reason TEXT,
        http_status INTEGER,
        content_hash TEXT,
        fetch_status TEXT NOT NULL DEFAULT 'pending'
                     CHECK (fetch_status IN ('pending','ok','failed','blocked','skipped')),
        fetch_error TEXT,
        fetched_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (competitor_id, url)
      );

      CREATE INDEX IF NOT EXISTS idx_cpages_competitor ON competitor_pages(competitor_id);
      CREATE INDEX IF NOT EXISTS idx_cpages_ws ON competitor_pages(workspace_id);

      -- Every extracted fact keeps its source. No row without a source URL.
      CREATE TABLE IF NOT EXISTS competitor_evidence (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        competitor_id TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
        page_id TEXT,
        source_url TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        field TEXT,
        excerpt TEXT,
        content_hash TEXT,
        confidence REAL,
        verification_status TEXT NOT NULL DEFAULT 'observed'
                            CHECK (verification_status IN ('observed','inferred','unverified')),
        collected_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cev_competitor ON competitor_evidence(competitor_id);
      CREATE INDEX IF NOT EXISTS idx_cev_ws ON competitor_evidence(workspace_id);
    `
  },
  {
    version: 9,
    name: 'ai-intelligence-engine',
    sql: `
      CREATE TABLE IF NOT EXISTS ai_analyses (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        competitor_id TEXT NOT NULL,
        scan_id TEXT,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        analysis_version INTEGER NOT NULL,
        prompt_version INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER,
        tokens_out INTEGER,
        error TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_analyses_unique
        ON ai_analyses(competitor_id, stage, input_hash, analysis_version);
      CREATE INDEX IF NOT EXISTS idx_ai_analyses_scan ON ai_analyses(scan_id, stage);
      CREATE INDEX IF NOT EXISTS idx_ai_analyses_workspace ON ai_analyses(workspace_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS ai_findings (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        competitor_id TEXT,
        scan_id TEXT,
        analysis_id TEXT,
        kind TEXT NOT NULL,
        statement TEXT NOT NULL,
        detail TEXT,
        claim TEXT NOT NULL,
        confidence REAL,
        evidence_ids TEXT NOT NULL,
        source_urls TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_findings_comp ON ai_findings(competitor_id, kind);
      CREATE INDEX IF NOT EXISTS idx_ai_findings_scan ON ai_findings(scan_id, kind);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_findings_dedupe
        ON ai_findings(analysis_id, kind, statement);

      CREATE TABLE IF NOT EXISTS ai_usage (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scan_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        day TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_usage_scan ON ai_usage(scan_id);
      CREATE INDEX IF NOT EXISTS idx_ai_usage_day ON ai_usage(day);

      CREATE TABLE IF NOT EXISTS ai_reports (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scan_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        analysis_version INTEGER NOT NULL,
        competitors TEXT NOT NULL,
        evidence_snapshot TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_reports_version ON ai_reports(scan_id, version);
      CREATE INDEX IF NOT EXISTS idx_ai_reports_workspace ON ai_reports(workspace_id, created_at DESC);
    `
  },
  {
    version: 10,
    name: 'competitor-intelligence-collection',
    sql: `
      -- Phase 4: collected page content and structured intelligence.
      -- Pages gain the fetch metadata needed to explain a partial crawl, plus the
      -- text the extractors read (bounded, never the raw HTML).
      ALTER TABLE competitor_pages ADD COLUMN relevance_score REAL;
      ALTER TABLE competitor_pages ADD COLUMN discovery_source TEXT;
      ALTER TABLE competitor_pages ADD COLUMN depth INTEGER;
      ALTER TABLE competitor_pages ADD COLUMN final_url TEXT;
      ALTER TABLE competitor_pages ADD COLUMN title TEXT;
      ALTER TABLE competitor_pages ADD COLUMN text_content TEXT;
      ALTER TABLE competitor_pages ADD COLUMN text_chars INTEGER;
      ALTER TABLE competitor_pages ADD COLUMN fetched_bytes INTEGER;
      ALTER TABLE competitor_pages ADD COLUMN duplicate_of TEXT;

      -- One row per collection attempt. A run that died mid-flight is visible and
      -- recoverable instead of leaving pages stuck in 'pending'.
      CREATE TABLE IF NOT EXISTS competitor_crawls (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        competitor_id TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
        scan_id TEXT,
        status TEXT NOT NULL DEFAULT 'running'
               CHECK (status IN ('running','completed','partial','failed')),
        page_budget INTEGER,
        pages_attempted INTEGER NOT NULL DEFAULT 0,
        pages_ok INTEGER NOT NULL DEFAULT 0,
        pages_failed INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ccrawls_competitor ON competitor_crawls(competitor_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ccrawls_ws ON competitor_crawls(workspace_id, status);

      -- Extracted features. Append-only: a page that changes produces a new row,
      -- so an old claim keeps the evidence it was extracted from.
      CREATE TABLE IF NOT EXISTS competitor_features (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        competitor_id TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
        page_id TEXT,
        crawl_id TEXT,
        source_url TEXT NOT NULL,
        page_type TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        category TEXT,
        claim_level TEXT NOT NULL
                    CHECK (claim_level IN ('documented','marketing','inferred','unverified')),
        confidence REAL,
        verification_status TEXT NOT NULL DEFAULT 'observed'
                            CHECK (verification_status IN ('observed','inferred','unverified')),
        evidence_id TEXT,
        evidence_excerpt TEXT,
        content_hash TEXT,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cfeat_competitor ON competitor_features(competitor_id, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cfeat_ws ON competitor_features(workspace_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cfeat_dedupe
        ON competitor_features(competitor_id, identity_key, content_hash);

      -- Extracted plans. price_value is the number printed on the page; it is never
      -- converted to another currency, and price_display keeps the original wording.
      CREATE TABLE IF NOT EXISTS competitor_plans (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        competitor_id TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
        page_id TEXT,
        crawl_id TEXT,
        source_url TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        plan_name TEXT NOT NULL,
        price_display TEXT,
        price_value REAL,
        currency TEXT,
        currency_display TEXT,
        billing_interval TEXT NOT NULL DEFAULT 'unknown'
                CHECK (billing_interval IN ('month','year','week','day','one_time','custom','unknown')),
        billing_note TEXT,
        is_starting_price INTEGER NOT NULL DEFAULT 0,
        price_stated INTEGER NOT NULL DEFAULT 0,
        free_plan INTEGER,
        trial_days INTEGER,
        trial_display TEXT,
        usage_based INTEGER,
        enterprise_custom INTEGER,
        limits TEXT,
        plan_features TEXT,
        original_text TEXT NOT NULL,
        confidence REAL,
        verification_status TEXT NOT NULL DEFAULT 'observed'
                            CHECK (verification_status IN ('observed','inferred','unverified')),
        evidence_id TEXT,
        content_hash TEXT,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cplan_competitor ON competitor_plans(competitor_id, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cplan_ws ON competitor_plans(workspace_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cplan_dedupe
        ON competitor_plans(competitor_id, identity_key, content_hash);

      -- Current pricing answer per competitor. NULL means unknown: an absent price
      -- is never turned into 0, and an absent free plan is never turned into 'paid'.
      CREATE TABLE IF NOT EXISTS competitor_pricing (
        competitor_id TEXT PRIMARY KEY REFERENCES competitors(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        crawl_id TEXT,
        has_pricing_evidence INTEGER NOT NULL DEFAULT 0,
        free_plan INTEGER,
        free_trial INTEGER,
        trial_days INTEGER,
        trial_display TEXT,
        starting_price_display TEXT,
        starting_price_value REAL,
        currency TEXT,
        billing_interval TEXT,
        usage_based INTEGER,
        enterprise_custom INTEGER,
        plans_count INTEGER NOT NULL DEFAULT 0,
        source_url TEXT,
        confidence REAL,
        extracted_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cpricing_ws ON competitor_pricing(workspace_id);
    `
  },
  {
    version: 11,
    name: 'evidence-versioning-and-ai-evidence-snapshots',
    sql: `
      -- Evidence becomes a version chain per identity instead of an undifferentiated
      -- append log. A row is never edited: a content change closes the previous
      -- version (superseded_by) and a new row is inserted.
      ALTER TABLE competitor_evidence ADD COLUMN identity_key TEXT;
      ALTER TABLE competitor_evidence ADD COLUMN content_hash_norm TEXT;
      ALTER TABLE competitor_evidence ADD COLUMN version INTEGER;
      ALTER TABLE competitor_evidence ADD COLUMN observed_at TEXT;
      ALTER TABLE competitor_evidence ADD COLUMN superseded_at TEXT;
      ALTER TABLE competitor_evidence ADD COLUMN superseded_by TEXT;
      ALTER TABLE competitor_evidence ADD COLUMN last_seen_at TEXT;
      ALTER TABLE competitor_evidence ADD COLUMN observations INTEGER NOT NULL DEFAULT 1;

      -- One row per distinct content per identity: recording the same observation
      -- twice is a duplicate, not a second fact. Legacy rows (NULL identity) stay.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cev_content_unique
        ON competitor_evidence(competitor_id, identity_key, content_hash_norm);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cev_version_unique
        ON competitor_evidence(competitor_id, identity_key, version);
      CREATE INDEX IF NOT EXISTS idx_cev_current
        ON competitor_evidence(workspace_id, competitor_id, superseded_at);
      CREATE INDEX IF NOT EXISTS idx_cev_identity
        ON competitor_evidence(competitor_id, identity_key, version DESC);

      -- Exactly which evidence an AI analysis consumed, with the content hash it
      -- consumed. This is how "changed since the last analysis" stays precise and
      -- how a historical analysis can be re-read without guessing.
      CREATE TABLE IF NOT EXISTS ai_analysis_evidence (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        analysis_id TEXT NOT NULL,
        scan_id TEXT,
        competitor_id TEXT NOT NULL,
        evidence_kind TEXT NOT NULL
                 CHECK (evidence_kind IN ('page','feature','plan','pricing','competitor_page')),
        evidence_id TEXT NOT NULL,
        source_url TEXT,
        content_hash TEXT,
        observed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_aie_dedupe
        ON ai_analysis_evidence(analysis_id, evidence_kind, evidence_id, content_hash);
      CREATE INDEX IF NOT EXISTS idx_aie_competitor
        ON ai_analysis_evidence(workspace_id, competitor_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_aie_analysis
        ON ai_analysis_evidence(analysis_id);

      -- Evidence versioning backfill: existing rows become the current version of
      -- their identity, so no historical row is lost and no new one is invented.
      UPDATE competitor_evidence SET observed_at = collected_at WHERE observed_at IS NULL;
      UPDATE competitor_evidence SET last_seen_at = collected_at WHERE last_seen_at IS NULL;
    `
  },
  {
    version: 12,
    name: 'competitor-screenshots',
    sql: `
      -- A screenshot row is metadata about a captured image, never the image itself
      -- (bytes live in the configured storage provider). Status records what happened
      -- so a failed capture is visible instead of looking like "no screenshot yet".
      CREATE TABLE IF NOT EXISTS competitor_screenshots (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        competitor_id TEXT NOT NULL,
        page_id TEXT,
        url TEXT NOT NULL,
        page_type TEXT NOT NULL,
        status TEXT NOT NULL
                 CHECK (status IN ('captured','duplicate','failed','skipped','unavailable')),
        reason TEXT,
        content_hash TEXT,
        storage_provider TEXT,
        storage_key TEXT,
        storage_url TEXT,
        bytes INTEGER,
        width INTEGER,
        height INTEGER,
        duration_ms INTEGER,
        captured_at TEXT,
        duplicate_of TEXT,
        capture_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Deduplication: the same image for the same competitor is stored once. The
      -- hash is the image bytes, so a re-render that differs by a pixel is a new row.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_shot_hash_unique
        ON competitor_screenshots(competitor_id, content_hash)
        WHERE content_hash IS NOT NULL AND status = 'captured';
      CREATE INDEX IF NOT EXISTS idx_shot_competitor
        ON competitor_screenshots(workspace_id, competitor_id, page_type, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_shot_workspace
        ON competitor_screenshots(workspace_id, created_at DESC);
    `
  }
];
