CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  lifetime_free_audits_used INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT,
  google_id TEXT UNIQUE,
  reset_token_hash TEXT,
  reset_token_expires TIMESTAMPTZ,
  gsc_access_token TEXT,
  gsc_refresh_token TEXT,
  gsc_connected_at TIMESTAMPTZ,
  team_id INTEGER,
  github_installation_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gsc_access_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gsc_refresh_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gsc_connected_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_installation_id TEXT;

CREATE TABLE IF NOT EXISTS audits (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  technical_result JSONB,
  content_result JSONB,
  keyword_result JSONB,
  backlink_result JSONB,
  ai_recommendations JSONB,
  score INTEGER,
  is_shared BOOLEAN NOT NULL DEFAULT false,
  share_token UUID DEFAULT gen_random_uuid(),
  gsc_result JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE audits ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS share_token UUID DEFAULT gen_random_uuid();
ALTER TABLE audits ADD COLUMN IF NOT EXISTS gsc_result JSONB;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS crawl_status TEXT;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS pages_crawled_count INTEGER;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS core_web_vitals JSONB;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS robots_txt_result JSONB;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS sitemap_result JSONB;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS content_gap_result JSONB;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS backlink_gap_result JSONB;
CREATE INDEX IF NOT EXISTS idx_audits_share_token ON audits(share_token);

-- Site-wide crawl (Pro/Agency): one row per page found by the DataForSEO
-- on_page/task_post crawl, populated once the crawl completes.
CREATE TABLE IF NOT EXISTS crawled_pages (
  id SERIAL PRIMARY KEY,
  audit_id INTEGER REFERENCES audits(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status_code INTEGER,
  title TEXT,
  meta_description TEXT,
  h1_count INTEGER,
  word_count INTEGER,
  canonical_url TEXT,
  is_indexable BOOLEAN,
  load_time_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crawled_pages_audit_id ON crawled_pages(audit_id);

-- Internal link graph (Pro/Agency site-wide crawl): one row per internal
-- link found between two crawled pages, populated alongside crawled_pages
-- once the crawl completes. Used to detect orphan pages (no incoming
-- internal link) and broken internal links (pointing at a 4xx/5xx page).
-- to_page_id is NULL when the link target wasn't itself crawled (e.g. the
-- crawl's page limit was reached) — to_url is always kept so detection can
-- still match it against the sitemap or crawled_pages by URL.
CREATE TABLE IF NOT EXISTS page_links (
  id SERIAL PRIMARY KEY,
  audit_id INTEGER REFERENCES audits(id) ON DELETE CASCADE,
  from_page_id INTEGER REFERENCES crawled_pages(id) ON DELETE CASCADE,
  to_page_id INTEGER REFERENCES crawled_pages(id) ON DELETE SET NULL,
  to_url TEXT NOT NULL,
  anchor_text TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_page_links_audit_id ON page_links(audit_id);

-- AEO (Answer Engine Optimization) tracking: which queries a user wants
-- monitored for citations of their domain in AI assistant answers, and the
-- checks logged for each one over time. Modeled as time-series tracking
-- (like Core Web Vitals field data), not a per-audit result, since a single
-- audit run has no natural relationship to "was this cited this week" —
-- checks are driven by jobs/aeoTracking.js on its own schedule.
CREATE TABLE IF NOT EXISTS aeo_target_queries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  query TEXT NOT NULL,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, domain, query)
);
CREATE INDEX IF NOT EXISTS idx_aeo_target_queries_user_domain ON aeo_target_queries(user_id, domain);
-- Competitor domains the user wants compared against their own citation
-- checks for this query — see aeo_competitor_citations below.
ALTER TABLE aeo_target_queries ADD COLUMN IF NOT EXISTS competitor_domains TEXT[] NOT NULL DEFAULT '{}';

-- One row per provider per check (a single target query check produces up to
-- one row per provider in jobs/aeoTracking.js's PROVIDERS list).
CREATE TABLE IF NOT EXISTS aeo_queries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  query TEXT NOT NULL,
  provider TEXT NOT NULL,
  cited BOOLEAN NOT NULL,
  response_snippet TEXT,
  checked_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aeo_queries_user_domain ON aeo_queries(user_id, domain);
CREATE INDEX IF NOT EXISTS idx_aeo_queries_checked_at ON aeo_queries(checked_at);

-- One row per (competitor domain, provider) per check, recorded alongside the
-- user's own result in aeo_queries above for the same query/provider/
-- checked_at. jobs/aeoTracking.js compares each row here against the
-- previous one for the same (user, domain, query, competitor_domain,
-- provider) to detect the transition into "competitor cited, user isn't" —
-- an already-cited competitor doesn't re-alert on every weekly check.
CREATE TABLE IF NOT EXISTS aeo_competitor_citations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  query TEXT NOT NULL,
  competitor_domain TEXT NOT NULL,
  provider TEXT NOT NULL,
  cited BOOLEAN NOT NULL,
  checked_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aeo_competitor_citations_lookup
  ON aeo_competitor_citations(user_id, domain, query, competitor_domain, provider, checked_at DESC);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT UNIQUE,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quick_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL,
  ip_address TEXT,
  score INTEGER,
  issues_count INTEGER,
  full_result JSONB,
  claimed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS monitored_domains (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  recurring_enabled BOOLEAN NOT NULL DEFAULT false,
  recurring_interval_days INTEGER,
  recurring_delivery TEXT DEFAULT 'in_app',
  last_recurring_run_at TIMESTAMPTZ,
  auto_fix_enabled BOOLEAN NOT NULL DEFAULT false,
  wp_url TEXT,
  wp_username TEXT,
  wp_app_password_encrypted BYTEA,
  gsc_site_url TEXT,
  github_repo TEXT,
  github_branch TEXT,
  competitor_domains TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, domain)
);

ALTER TABLE monitored_domains ADD COLUMN IF NOT EXISTS recurring_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE monitored_domains ADD COLUMN IF NOT EXISTS recurring_interval_days INTEGER;
ALTER TABLE monitored_domains ADD COLUMN IF NOT EXISTS recurring_delivery TEXT DEFAULT 'in_app';
ALTER TABLE monitored_domains ADD COLUMN IF NOT EXISTS last_recurring_run_at TIMESTAMPTZ;
ALTER TABLE monitored_domains ADD COLUMN IF NOT EXISTS auto_fix_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE monitored_domains ADD COLUMN IF NOT EXISTS wp_url TEXT;
ALTER TABLE monitored_domains ADD COLUMN IF NOT EXISTS wp_username TEXT;
ALTER TABLE monitored_domains ADD COLUMN IF NOT EXISTS wp_app_password_encrypted BYTEA;
ALTER TABLE monitored_domains ADD COLUMN IF NOT EXISTS gsc_site_url TEXT;
ALTER TABLE monitored_domains ADD COLUMN IF NOT EXISTS github_repo TEXT;
ALTER TABLE monitored_domains ADD COLUMN IF NOT EXISTS github_branch TEXT;
-- Competitor domains for the backlink-gap check (Agency only — see
-- config/plans.js backlinkGapAnalysis — it's the most expensive backlinks
-- API call, so it's opt-in per domain rather than run on every audit).
ALTER TABLE monitored_domains ADD COLUMN IF NOT EXISTS competitor_domains TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  white_label_logo_url TEXT,
  white_label_brand_color TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_members (
  id SERIAL PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (team_id, invited_email)
);

-- Added after both tables exist (users.team_id predates the teams table in
-- this file). ON DELETE SET NULL guarantees that whenever a team disappears
-- — owner account deleted, team explicitly deleted, whatever the code path —
-- every member's users.team_id is cleared automatically, so nobody is ever
-- left pointing at a team_id that no longer exists.
-- Clears any team_id already left dangling (e.g. by a pre-fix deployment)
-- before adding the constraint, since Postgres validates existing rows
-- when a FK is added and would otherwise refuse to apply this migration.
UPDATE users SET team_id = NULL WHERE team_id IS NOT NULL AND team_id NOT IN (SELECT id FROM teams);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_team_id_fkey') THEN
    ALTER TABLE users ADD CONSTRAINT users_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;
  END IF;
END $$;
