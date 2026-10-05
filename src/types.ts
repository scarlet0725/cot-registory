/**
 * Shared types and constants for the cot registry.
 */

export interface Env {
  /** R2 bucket holding blob/manifest content and upload staging. */
  BUCKET: R2Bucket;
  /** D1 database holding registry metadata (see migrations/). */
  DB: D1Database;

  /**
   * Secret. Admin credentials for the /admin dashboard (token issuance,
   * repository visibility). When both are unset the registry runs in OPEN
   * mode (everything allowed; local dev only).
   */
  ADMIN_USERNAME?: string;
  /** Secret. */
  ADMIN_PASSWORD?: string;
  /** Display name for the dashboard header. */
  REGISTRY_NAME?: string;
}

/** Row shape for the `uploads` table. */
export interface UploadRow {
  id: string;
  repo: string;
  r2_key: string;
  r2_upload_id: string | null;
  bytes_received: number;
  part_size: number | null;
  last_part_size: number | null;
  parts: string; // JSON-encoded R2UploadedPart[]
  created_at: number;
  updated_at: number;
}

/** Row shape for the `manifests` table. */
export interface ManifestRow {
  repo: string;
  digest: string;
  media_type: string | null;
  artifact_type: string | null;
  subject_digest: string | null;
  annotations: string | null;
  size: number;
  created_at: number;
}

// ---------------------------------------------------------------------------
// R2 key layout
// ---------------------------------------------------------------------------

export const blobKey = (digest: string): string => `blobs/${digest}`;
export const manifestKey = (digest: string): string => `manifests/${digest}`;
export const stagingKey = (uploadId: string): string => `staging/${uploadId}`;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** R2 multipart parts must be >= 5 MiB (except the final part). */
export const MIN_CHUNK_SIZE = 5 * 1024 * 1024;
/** Maximum accepted manifest body. */
export const MAX_MANIFEST_SIZE = 4 * 1024 * 1024;
/** Upload sessions idle longer than this are garbage-collected. */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Unlinked blobs younger than this are kept (may be part of an in-flight push). */
export const ORPHAN_BLOB_GRACE_MS = 60 * 60 * 1000;
/** Default page size for tags/list and catalog when ?n= is absent. */
export const DEFAULT_PAGE_SIZE = 1000;

// ---------------------------------------------------------------------------
// Media types
// ---------------------------------------------------------------------------

export const MT_OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
export const MT_OCI_INDEX = "application/vnd.oci.image.index.v1+json";
export const MT_DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
export const MT_DOCKER_MANIFEST_LIST = "application/vnd.docker.distribution.manifest.list.v2+json";
export const MT_OCTET_STREAM = "application/octet-stream";

/** Media types treated as an index (child entries are manifests). */
export const INDEX_MEDIA_TYPES: readonly string[] = [MT_OCI_INDEX, MT_DOCKER_MANIFEST_LIST];
