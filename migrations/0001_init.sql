-- cot registry metadata schema.
-- Blob and manifest *content* lives in R2; D1 holds the metadata needed for
-- OCI API semantics (tags, links, referrers) and the dashboard.

CREATE TABLE IF NOT EXISTS repositories (
  name       TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Content-addressed blob store index. Blobs are shared across repositories;
-- the R2 object lives at `blobs/<digest>`.
CREATE TABLE IF NOT EXISTS blobs (
  digest     TEXT PRIMARY KEY,       -- "sha256:<64 hex>"
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Which repositories may serve which blobs (per-repo visibility + GC roots).
CREATE TABLE IF NOT EXISTS repo_blobs (
  repo       TEXT NOT NULL,
  digest     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo, digest)
);
CREATE INDEX IF NOT EXISTS idx_repo_blobs_digest ON repo_blobs (digest);

-- Manifests known per repository. Content lives in R2 at `manifests/<digest>`
-- (shared across repos; delete the object only when no row references it).
CREATE TABLE IF NOT EXISTS manifests (
  repo           TEXT NOT NULL,
  digest         TEXT NOT NULL,      -- "sha256:<64 hex>"
  media_type     TEXT,
  artifact_type  TEXT,               -- manifest.artifactType ?? config.mediaType (for referrers)
  subject_digest TEXT,               -- manifest.subject.digest (for referrers)
  annotations    TEXT,               -- JSON object, for referrers descriptors
  size           INTEGER NOT NULL,   -- manifest byte size
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (repo, digest)
);
CREATE INDEX IF NOT EXISTS idx_manifests_subject ON manifests (repo, subject_digest);
CREATE INDEX IF NOT EXISTS idx_manifests_digest ON manifests (digest);

CREATE TABLE IF NOT EXISTS tags (
  repo       TEXT NOT NULL,
  tag        TEXT NOT NULL,
  digest     TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_digest ON tags (repo, digest);

-- In-progress chunked upload sessions (OCI POST/PATCH/PUT flow).
-- Data is staged in an R2 multipart upload at `staging/<id>` and copied to
-- its content address on completion (R2 has no rename).
CREATE TABLE IF NOT EXISTS uploads (
  id             TEXT PRIMARY KEY,   -- crypto.randomUUID()
  repo           TEXT NOT NULL,
  r2_key         TEXT NOT NULL,      -- "staging/<id>"
  r2_upload_id   TEXT,               -- R2 multipart uploadId; NULL until first chunk
  bytes_received INTEGER NOT NULL DEFAULT 0,
  part_size      INTEGER,            -- size of first chunk; R2 requires uniform parts (except last)
  last_part_size INTEGER,            -- size of most recent chunk (to detect "short part then more data")
  parts          TEXT NOT NULL DEFAULT '[]', -- JSON: [{"partNumber":1,"etag":"..."}]
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_updated ON uploads (updated_at);
