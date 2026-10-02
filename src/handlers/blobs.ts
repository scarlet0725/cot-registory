/**
 * Blob read/delete endpoints.
 *
 * GET/HEAD /v2/<name>/blobs/<digest>
 *   - The (repo, digest) link must exist in `repo_blobs`, else 404 BLOB_UNKNOWN.
 *   - GET streams the R2 object; supports a single `Range: bytes=a-b` header
 *     (206 + Content-Range). Headers: Docker-Content-Digest, Content-Length,
 *     Content-Type: application/octet-stream, Accept-Ranges: bytes.
 *   - HEAD returns the same headers, no body.
 *
 * DELETE /v2/<name>/blobs/<digest>
 *   - Remove the repo link; when no other repo links the digest, delete the
 *     `blobs` row and the R2 object. 202 on success, 404 BLOB_UNKNOWN if the
 *     link does not exist.
 */

import type { Env } from "../types";
import { blobKey, MT_OCTET_STREAM } from "../types";
import { ociError } from "../oci/errors";
import type { ParsedDigest } from "../oci/validation";

interface BlobRange {
  offset: number;
  length: number;
}

/**
 * Parse a single-range `Range` header against a known content size.
 * Returns null for a missing or malformed header (=> serve the full blob),
 * "unsatisfiable" when the requested range lies beyond the content.
 */
function parseRangeHeader(
  header: string | null,
  size: number,
): BlobRange | "unsatisfiable" | null {
  if (header === null) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const startStr = m[1]!;
  const endStr = m[2]!;
  if (startStr === "" && endStr === "") return null;
  if (startStr === "") {
    // Suffix form bytes=-n: the last n bytes.
    const n = Number(endStr);
    if (n === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(n, size);
    return { offset: size - length, length };
  }
  const start = Number(startStr);
  if (start >= size) return "unsatisfiable";
  if (endStr === "") return { offset: start, length: size - start };
  const end = Math.min(Number(endStr), size - 1);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}

function blobHeaders(digest: ParsedDigest): Record<string, string> {
  return {
    "Content-Type": MT_OCTET_STREAM,
    "Docker-Content-Digest": digest.digest,
    "Accept-Ranges": "bytes",
    ETag: `"${digest.digest}"`,
  };
}

export async function handleBlobGetOrHead(
  env: Env,
  repo: string,
  digest: ParsedDigest,
  request: Request,
): Promise<Response> {
  if (!digest.supported) {
    return ociError(404, "BLOB_UNKNOWN", undefined, { digest: digest.digest });
  }

  const row = await env.DB
    .prepare(
      "SELECT b.size AS size FROM repo_blobs rb JOIN blobs b ON b.digest = rb.digest WHERE rb.repo = ? AND rb.digest = ?",
    )
    .bind(repo, digest.digest)
    .first<{ size: number }>();
  if (!row) {
    return ociError(404, "BLOB_UNKNOWN", undefined, { digest: digest.digest });
  }

  if (request.method === "HEAD") {
    // Metadata lives in D1; no R2 read needed.
    return new Response(null, {
      status: 200,
      headers: { ...blobHeaders(digest), "Content-Length": String(row.size) },
    });
  }

  const range = parseRangeHeader(request.headers.get("Range"), row.size);
  if (range === "unsatisfiable") {
    return ociError(416, "SIZE_INVALID", "requested range not satisfiable", {
      digest: digest.digest,
    }, { "Content-Range": `bytes */${row.size}` });
  }

  if (range !== null) {
    const obj = await env.BUCKET.get(blobKey(digest.digest), { range });
    if (!obj) return ociError(404, "BLOB_UNKNOWN", undefined, { digest: digest.digest });
    const end = range.offset + range.length - 1;
    return new Response(obj.body, {
      status: 206,
      headers: {
        ...blobHeaders(digest),
        "Content-Length": String(range.length),
        "Content-Range": `bytes ${range.offset}-${end}/${row.size}`,
      },
    });
  }

  const obj = await env.BUCKET.get(blobKey(digest.digest));
  if (!obj) return ociError(404, "BLOB_UNKNOWN", undefined, { digest: digest.digest });
  return new Response(obj.body, {
    status: 200,
    headers: { ...blobHeaders(digest), "Content-Length": String(row.size) },
  });
}

export async function handleBlobDelete(
  env: Env,
  repo: string,
  digest: ParsedDigest,
): Promise<Response> {
  if (!digest.supported) {
    return ociError(404, "BLOB_UNKNOWN", undefined, { digest: digest.digest });
  }

  const result = await env.DB
    .prepare("DELETE FROM repo_blobs WHERE repo = ? AND digest = ?")
    .bind(repo, digest.digest)
    .run();
  if (result.meta.changes === 0) {
    return ociError(404, "BLOB_UNKNOWN", undefined, { digest: digest.digest });
  }

  // Drop the global index row only while no repo links the digest — the guard
  // is one atomic statement, so a concurrent push/mount re-linking the blob
  // keeps the row. The R2 object itself is never deleted inline (a concurrent
  // push may be mid-commit); the GC pass removes blob objects whose digest has
  // no `blobs` row left.
  await env.DB
    .prepare(
      "DELETE FROM blobs WHERE digest = ? AND NOT EXISTS (SELECT 1 FROM repo_blobs WHERE digest = ?)",
    )
    .bind(digest.digest, digest.digest)
    .run();

  return new Response(null, { status: 202, headers: { "Content-Length": "0" } });
}
