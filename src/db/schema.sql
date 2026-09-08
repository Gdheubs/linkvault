-- ============================================================
--  LinkVault :: schema
--  Money is stored in MICROS (1 USD = 1_000_000 micros).
--  Never use floats for money.
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT    NOT NULL UNIQUE,
  password_hash   TEXT    NOT NULL,
  name            TEXT    NOT NULL DEFAULT '',
  role            TEXT    NOT NULL DEFAULT 'publisher',   -- publisher | admin
  status          TEXT    NOT NULL DEFAULT 'active',      -- active | suspended | banned
  balance_micros  INTEGER NOT NULL DEFAULT 0,             -- withdrawable
  pending_micros  INTEGER NOT NULL DEFAULT 0,             -- held during the fraud review window
  paid_micros     INTEGER NOT NULL DEFAULT 0,
  ref_code        TEXT    NOT NULL UNIQUE,
  referred_by     INTEGER REFERENCES users(id),
  ref_earn_micros INTEGER NOT NULL DEFAULT 0,
  api_key         TEXT    NOT NULL UNIQUE,
  tg_chat_id      TEXT,
  payout_method   TEXT    NOT NULL DEFAULT '',
  payout_address  TEXT    NOT NULL DEFAULT '',
  fraud_score     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_ref ON users(ref_code);
CREATE INDEX IF NOT EXISTS idx_users_referred ON users(referred_by);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_hash     TEXT,
  ua          TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ---------- Telegram-backed file storage ----------
CREATE TABLE IF NOT EXISTS resources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tg_file_id    TEXT NOT NULL,
  tg_unique_id  TEXT,
  tg_message_id INTEGER,
  kind          TEXT NOT NULL DEFAULT 'document',  -- document|video|photo|audio
  file_name     TEXT NOT NULL DEFAULT '',
  mime          TEXT NOT NULL DEFAULT '',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  checksum      TEXT,
  status        TEXT NOT NULL DEFAULT 'ready',     -- ready|quarantined|removed
  downloads     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_user ON resources(user_id);

-- ---------- Monetization campaigns (configurable step flow) ----------
CREATE TABLE IF NOT EXISTS campaigns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  owner_id      INTEGER REFERENCES users(id) ON DELETE CASCADE, -- NULL = platform default
  steps         TEXT NOT NULL,          -- JSON array of step definitions
  wait_seconds  INTEGER NOT NULL DEFAULT 15,
  skip_mode     TEXT NOT NULL DEFAULT 'engagement', -- engagement | ad_click | none
  targeting     TEXT NOT NULL DEFAULT '{}',         -- JSON {countries,devices,step_override}
  priority      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL
);

-- ---------- Short links ----------
CREATE TABLE IF NOT EXISTS links (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL UNIQUE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  destination      TEXT NOT NULL DEFAULT '',
  resource_id      INTEGER REFERENCES resources(id) ON DELETE SET NULL,
  campaign_id      INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  title            TEXT NOT NULL DEFAULT '',
  description      TEXT NOT NULL DEFAULT '',
  password         TEXT,
  expires_at       INTEGER,
  max_clicks       INTEGER,
  status           TEXT NOT NULL DEFAULT 'active',   -- active|paused|blocked
  clicks           INTEGER NOT NULL DEFAULT 0,
  unique_clicks    INTEGER NOT NULL DEFAULT 0,
  valid_visits     INTEGER NOT NULL DEFAULT 0,
  completed_visits INTEGER NOT NULL DEFAULT 0,
  revenue_micros   INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_user ON links(user_id);
CREATE INDEX IF NOT EXISTS idx_links_code ON links(code);

-- ---------- Visits (the analytics + revenue spine) ----------
CREATE TABLE IF NOT EXISTS visits (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_key         TEXT NOT NULL UNIQUE,
  link_id           INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  publisher_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id       INTEGER,
  ip_hash           TEXT NOT NULL,
  fp_hash           TEXT,
  ua                TEXT NOT NULL DEFAULT '',
  country           TEXT NOT NULL DEFAULT 'XX',
  device            TEXT NOT NULL DEFAULT 'desktop',
  os                TEXT NOT NULL DEFAULT '',
  browser           TEXT NOT NULL DEFAULT '',
  referer           TEXT NOT NULL DEFAULT '',
  step_count        INTEGER NOT NULL DEFAULT 0,
  step_reached      INTEGER NOT NULL DEFAULT 0,
  is_unique         INTEGER NOT NULL DEFAULT 0,
  is_valid          INTEGER NOT NULL DEFAULT 0,
  is_completed      INTEGER NOT NULL DEFAULT 0,
  fraud_score       INTEGER NOT NULL DEFAULT 0,
  fraud_reasons     TEXT NOT NULL DEFAULT '[]',
  cpm_micros        INTEGER NOT NULL DEFAULT 0,
  revenue_micros    INTEGER NOT NULL DEFAULT 0,
  publisher_micros  INTEGER NOT NULL DEFAULT 0,
  platform_micros   INTEGER NOT NULL DEFAULT 0,
  referral_micros   INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  completed_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_visits_link ON visits(link_id, created_at);
CREATE INDEX IF NOT EXISTS idx_visits_pub ON visits(publisher_id, created_at);
CREATE INDEX IF NOT EXISTS idx_visits_ip ON visits(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at);

CREATE TABLE IF NOT EXISTS visit_steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id      INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  step_index    INTEGER NOT NULL,
  entered_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  dwell_ms      INTEGER NOT NULL DEFAULT 0,
  interactions  INTEGER NOT NULL DEFAULT 0,
  focus_ms      INTEGER NOT NULL DEFAULT 0,
  skipped_via   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_vsteps ON visit_steps(visit_id, step_index);

CREATE TABLE IF NOT EXISTS impressions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id    INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  slot_key    TEXT NOT NULL,
  step_index  INTEGER NOT NULL DEFAULT 0,
  viewable    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_impr_visit ON impressions(visit_id);

-- ---------- Completion tokens (signed unlock) ----------
CREATE TABLE IF NOT EXISTS completion_tokens (
  jti         TEXT PRIMARY KEY,
  visit_id    INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  link_id     INTEGER NOT NULL,
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  use_count   INTEGER NOT NULL DEFAULT 0
);

-- ---------- Revenue ----------
CREATE TABLE IF NOT EXISTS rate_cards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  country     TEXT NOT NULL DEFAULT '*',
  device      TEXT NOT NULL DEFAULT '*',
  cpm_micros  INTEGER NOT NULL,
  fill_rate   REAL NOT NULL DEFAULT 1.0,
  active      INTEGER NOT NULL DEFAULT 1,
  note        TEXT NOT NULL DEFAULT '',
  UNIQUE(country, device)
);

CREATE TABLE IF NOT EXISTS ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,     -- earning|referral|payout|adjustment|reversal|release
  amount_micros INTEGER NOT NULL,  -- signed
  ref_type      TEXT NOT NULL DEFAULT '',
  ref_id        INTEGER,
  note          TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at);

CREATE TABLE IF NOT EXISTS payouts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_micros INTEGER NOT NULL,
  method        TEXT NOT NULL,
  address       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|approved|paid|rejected
  note          TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  processed_at  INTEGER,
  processed_by  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payouts_user ON payouts(user_id);

CREATE TABLE IF NOT EXISTS daily_stats (
  day               TEXT NOT NULL,
  user_id           INTEGER NOT NULL,
  link_id           INTEGER NOT NULL DEFAULT 0,
  country           TEXT NOT NULL DEFAULT '*',
  device            TEXT NOT NULL DEFAULT '*',
  clicks            INTEGER NOT NULL DEFAULT 0,
  unique_clicks     INTEGER NOT NULL DEFAULT 0,
  valid_visits      INTEGER NOT NULL DEFAULT 0,
  completed_visits  INTEGER NOT NULL DEFAULT 0,
  revenue_micros    INTEGER NOT NULL DEFAULT 0,
  publisher_micros  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, link_id, country, device)
);

-- ---------- Anti-fraud ----------
CREATE TABLE IF NOT EXISTS fraud_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id    INTEGER,
  user_id     INTEGER,
  ip_hash     TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL,
  severity    INTEGER NOT NULL DEFAULT 1,
  meta        TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fraud_created ON fraud_events(created_at);

CREATE TABLE IF NOT EXISTS blocklist (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,   -- ip|iprange|domain|country|ua|asn
  value       TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  UNIQUE(kind, value)
);

-- ---------- Ads / promo inventory ----------
CREATE TABLE IF NOT EXISTS ad_slots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_key    TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'banner',  -- banner|native|inarticle|video|popup|interstitial
  provider    TEXT NOT NULL DEFAULT 'adsense', -- adsense|youtube|house|custom
  html        TEXT NOT NULL DEFAULT '',
  youtube_id  TEXT NOT NULL DEFAULT '',
  href        TEXT NOT NULL DEFAULT '',
  image       TEXT NOT NULL DEFAULT '',
  headline    TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  placement   TEXT NOT NULL DEFAULT 'gateway',  -- gateway|site|blog|both
  enabled     INTEGER NOT NULL DEFAULT 1,
  weight      INTEGER NOT NULL DEFAULT 10,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0
);

-- ---------- Content (the AdSense-qualifying surface) ----------
CREATE TABLE IF NOT EXISTS posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  excerpt      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  cover        TEXT NOT NULL DEFAULT '',
  tags         TEXT NOT NULL DEFAULT '',
  author       TEXT NOT NULL DEFAULT 'LinkVault Team',
  read_minutes INTEGER NOT NULL DEFAULT 5,
  status       TEXT NOT NULL DEFAULT 'published',
  views        INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  tagline      TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  features     TEXT NOT NULL DEFAULT '[]',
  price_micros INTEGER NOT NULL DEFAULT 0,
  period       TEXT NOT NULL DEFAULT 'one-time',
  image        TEXT NOT NULL DEFAULT '',
  url          TEXT NOT NULL DEFAULT '',
  badge        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active',
  sort         INTEGER NOT NULL DEFAULT 0,
  clicks       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pages (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  subject    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'general', -- general|dmca|advertiser
  status     TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER,
  action     TEXT NOT NULL,
  meta       TEXT NOT NULL DEFAULT '{}',
  ip_hash    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- ---------- Paid promotions (advertisers buy placement) ----------
CREATE TABLE IF NOT EXISTS promotions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL DEFAULT 'blog',   -- blog | youtube | product | link
  title          TEXT NOT NULL,
  blurb          TEXT NOT NULL DEFAULT '',
  url            TEXT NOT NULL DEFAULT '',
  youtube_id     TEXT NOT NULL DEFAULT '',
  image          TEXT NOT NULL DEFAULT '',
  cta            TEXT NOT NULL DEFAULT 'Read more',

  advertiser     TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  note           TEXT NOT NULL DEFAULT '',

  package        TEXT NOT NULL DEFAULT '',       -- package key at purchase time
  placement      TEXT NOT NULL DEFAULT 'gateway',-- gateway | blog | site | everywhere
  price_micros   INTEGER NOT NULL DEFAULT 0,
  days           INTEGER NOT NULL DEFAULT 7,
  weight         INTEGER NOT NULL DEFAULT 10,

  status         TEXT NOT NULL DEFAULT 'pending',-- pending|approved|active|paused|expired|rejected
  paid           INTEGER NOT NULL DEFAULT 0,
  payment_ref    TEXT NOT NULL DEFAULT '',

  starts_at      INTEGER,
  ends_at        INTEGER,
  impressions    INTEGER NOT NULL DEFAULT 0,
  clicks         INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  reviewed_at    INTEGER,
  reviewed_by    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_promos_live ON promotions(status, placement, ends_at);

-- ---------- Advertiser campaign analytics (daily rollup) ----------
CREATE TABLE IF NOT EXISTS promo_stats (
  day         TEXT NOT NULL,
  promo_id    INTEGER NOT NULL,
  surface     TEXT NOT NULL DEFAULT 'gateway',  -- gateway | blog | site
  country     TEXT NOT NULL DEFAULT 'XX',
  device      TEXT NOT NULL DEFAULT 'unknown',
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, promo_id, surface, country, device)
);
CREATE INDEX IF NOT EXISTS idx_promo_stats ON promo_stats(promo_id, day);
