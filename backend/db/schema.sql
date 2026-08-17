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
CREATE INDEX IF NOT EXISTS idx_audits_share_token ON audits(share_token);

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
