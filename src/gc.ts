/**
 * Garbage collection, run from the cron trigger (see wrangler.jsonc).
 *
 * 1. Abort + delete upload sessions idle longer than UPLOAD_SESSION_TTL_MS
 *    (abort the R2 multipart upload if started, delete any staged object,
 *    delete the `uploads` row).
 * 2. Delete blobs with no `repo_blobs` link older than ORPHAN_BLOB_GRACE_MS
 *    (delete the R2 object `blobs/<digest>` and the `blobs` row), and blob
 *    R2 objects with no `blobs` row (blob DELETE defers object removal here).
 * 3. Delete manifest R2 objects whose digest no longer appears in `manifests`
 *    (manifest DELETE defers object removal here too).
 */

import type { Env, UploadRow } from "./types";
import { ORPHAN_BLOB_GRACE_MS, UPLOAD_SESSION_TTL_MS, blobKey } from "./types";

export interface GCResult {
  uploadsDeleted: number;
  blobsDeleted: number;
  manifestsDeleted: number;
}

const STAGING_PREFIX = "staging/";
const MANIFEST_PREFIX = "manifests/";
const BLOB_PREFIX = "blobs/";
/** D1 batch statement limit we chunk to. */
const D1_BATCH_SIZE = 50;
/** R2 bulk delete accepts at most 1000 keys per call. */
const R2_DELETE_BATCH_SIZE = 1000;

/** Run prepared statements through env.DB.batch in chunks. */
async function batchRun(env: Env, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += D1_BATCH_SIZE) {
    await env.DB.batch(statements.slice(i, i + D1_BATCH_SIZE));
  }
}

/** Bulk-delete R2 keys in chunks of the per-call limit. */
async function bulkDelete(env: Env, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += R2_DELETE_BATCH_SIZE) {
    await env.BUCKET.delete(keys.slice(i, i + R2_DELETE_BATCH_SIZE));
  }
}

/** List every R2 key under `prefix`, keeping only objects `olderThanMs` stale. */
async function listStaleKeys(env: Env, prefix: string, olderThanMs: number): Promise<string[]> {
  const now = Date.now();
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix, cursor });
    for (const obj of page.objects) {
      if (now - obj.uploaded.getTime() > olderThanMs) keys.push(obj.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}

export async function runGC(env: Env): Promise<GCResult> {
  const now = Date.now();
  let uploadsDeleted = 0;

  // 1. Stale upload sessions: abort the multipart upload if one was started,
  //    best-effort delete the staged object, drop the row.
  const stale = await env.DB.prepare("SELECT * FROM uploads WHERE updated_at < ?")
    .bind(now - UPLOAD_SESSION_TTL_MS)
    .all<UploadRow>();
  const uploadRowDeletes: D1PreparedStatement[] = [];
  for (const row of stale.results) {
    if (row.r2_upload_id) {
      try {
        await env.BUCKET.resumeMultipartUpload(row.r2_key, row.r2_upload_id).abort();
      } catch {
        // Upload already aborted/completed/expired — nothing left to abort.
      }
    }
    try {
      await env.BUCKET.delete(row.r2_key);
    } catch {
      // Best-effort: the orphan-staging pass below retries old leftovers.
    }
    uploadRowDeletes.push(env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(row.id));
    uploadsDeleted++;
  }
  await batchRun(env, uploadRowDeletes);

  // 2. Orphan staged objects: staging keys with no uploads row (crash leftovers),
  //    old enough that no in-flight session can still own them.
  const liveUploads = await env.DB.prepare("SELECT id, r2_key FROM uploads").all<{
    id: string;
    r2_key: string;
  }>();
  const expectedStagingKeys = new Set(liveUploads.results.map((r) => r.r2_key));
  const staleStaging = (await listStaleKeys(env, STAGING_PREFIX, UPLOAD_SESSION_TTL_MS)).filter(
    (key) => !expectedStagingKeys.has(key),
  );
  await bulkDelete(env, staleStaging);
  uploadsDeleted += staleStaging.length;

  // 3. Orphan blobs: no repo links and past the grace window for in-flight pushes.
  const orphanBlobs = await env.DB.prepare(
    "SELECT b.digest FROM blobs b LEFT JOIN repo_blobs rb ON rb.digest = b.digest " +
      "WHERE rb.digest IS NULL AND b.created_at < ?",
  )
    .bind(now - ORPHAN_BLOB_GRACE_MS)
    .all<{ digest: string }>();
  const orphanDigests = orphanBlobs.results.map((r) => r.digest);
  await bulkDelete(env, orphanDigests.map(blobKey));
  await batchRun(
    env,
    orphanDigests.map((d) => env.DB.prepare("DELETE FROM blobs WHERE digest = ?").bind(d)),
  );
  let blobsDeleted = orphanDigests.length;

  // 3b. Orphan blob objects: R2 content with no `blobs` row (a blob DELETE
  //     leaves the object for this pass, and a crash between the R2 put and
  //     the D1 commit leaks one). A fresh push re-puts the object, refreshing
  //     `uploaded`, so the grace window makes this safe against in-flight work.
  const knownBlobRows = await env.DB.prepare("SELECT digest FROM blobs").all<{ digest: string }>();
  const knownBlobs = new Set(knownBlobRows.results.map((r) => r.digest));
  const orphanBlobKeys = (await listStaleKeys(env, BLOB_PREFIX, ORPHAN_BLOB_GRACE_MS)).filter(
    (key) => !knownBlobs.has(key.slice(BLOB_PREFIX.length)),
  );
  await bulkDelete(env, orphanBlobKeys);
  blobsDeleted += orphanBlobKeys.length;

  // 4. Orphan manifest objects: R2 content no manifests row references any more
  //    (manifest content is shared across repos, so check the digest globally).
  const knownRows = await env.DB.prepare("SELECT DISTINCT digest FROM manifests").all<{
    digest: string;
  }>();
  const knownManifests = new Set(knownRows.results.map((r) => r.digest));
  const orphanManifestKeys = (
    await listStaleKeys(env, MANIFEST_PREFIX, ORPHAN_BLOB_GRACE_MS)
  ).filter((key) => !knownManifests.has(key.slice(MANIFEST_PREFIX.length)));
  await bulkDelete(env, orphanManifestKeys);
  const manifestsDeleted = orphanManifestKeys.length;

  const result: GCResult = { uploadsDeleted, blobsDeleted, manifestsDeleted };
  console.log(
    `gc: uploads=${result.uploadsDeleted} blobs=${result.blobsDeleted} manifests=${result.manifestsDeleted}`,
  );
  return result;
}
