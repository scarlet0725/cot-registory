-- Issued access tokens and per-repository visibility.

-- Access tokens issued from the /admin dashboard. Clients authenticate with
-- Basic auth: username = token id, password = secret. Only the SHA-256 hash
-- of the secret is stored; the secret itself is shown once, at creation.
CREATE TABLE IF NOT EXISTS credentials (
  id           TEXT PRIMARY KEY,   -- random hex; doubles as the Basic auth username
  label        TEXT NOT NULL,      -- human-readable purpose, e.g. "ci-deploy"
  secret_hash  TEXT NOT NULL,      -- SHA-256 hex of the secret
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER             -- hourly granularity; NULL until first use
);

-- 'private' (default): pulls and dashboard pages require a token.
-- 'public': anonymous pulls, catalog listing, and dashboard viewing.
ALTER TABLE repositories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
  CHECK (visibility IN ('public', 'private'));
