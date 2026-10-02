/**
 * Manifest endpoints.
 *
 * PUT /v2/<name>/manifests/<reference>
 *   - Body <= MAX_MANIFEST_SIZE (else 413 MANIFEST_INVALID). Compute sha256.
 *   - reference: tag => upsert `tags` row; digest => must equal computed
 *     digest (400 DIGEST_INVALID otherwise).
 *   - Body must parse as JSON (400 MANIFEST_INVALID). Media type from
 *     Content-Type header, falling back to body.mediaType.
 *   - Reference checks: for image manifests, config + layers digests must
 *     exist in `repo_blobs` for this repo (or as manifests); for indexes,
 *     child manifests[].digest must exist in `manifests` for this repo.
 *     Missing => 404-style 400? No: 400 with code MANIFEST_BLOB_UNKNOWN.
 *   - subject: may reference a manifest that does not exist yet; record
 *     subject_digest and reply with the OCI-Subject header.
 *   - Store content in R2 at manifests/<digest>; upsert `manifests` row
 *     (media_type, artifact_type = artifactType ?? config.mediaType,
 *     subject_digest, annotations JSON, size); ensure `repositories` row.
 *   - 201, Location: /v2/<name>/manifests/<digest>, Docker-Content-Digest.
 *
 * GET/HEAD /v2/<name>/manifests/<reference>
 *   - Resolve tag via `tags`, digest via `manifests` (repo-scoped);
 *     unknown => 404 MANIFEST_UNKNOWN.
 *   - Reply with stored Content-Type, Content-Length, Docker-Content-Digest;
 *     HEAD omits the body.
 *
 * DELETE /v2/<name>/manifests/<reference>
 *   - Tag: delete the `tags` row => 202 (404 MANIFEST_UNKNOWN when absent).
 *   - Digest: delete `manifests` row + any tags pointing at it; delete the R2
 *     object only when no other repo references the digest => 202.
 */

import type { Env, ManifestRow } from "../types";
import {
  MAX_MANIFEST_SIZE,
  MT_DOCKER_MANIFEST,
  MT_DOCKER_MANIFEST_LIST,
  MT_OCI_INDEX,
  MT_OCI_MANIFEST,
  manifestKey,
} from "../types";
import { ociError } from "../oci/errors";
import { looksLikeDigest, parseDigest, sha256Hex } from "../oci/validation";
import { isJsonObject, verifyManifestReferences } from "./manifest-common";

const KNOWN_MANIFEST_TYPES: readonly string[] = [
  MT_OCI_MANIFEST,
  MT_OCI_INDEX,
  MT_DOCKER_MANIFEST,
  MT_DOCKER_MANIFEST_LIST,
];

/**
 * The stored media type is echoed verbatim as the Content-Type of later GETs,
 * so restrict it to types a browser can never render (defense against stored
 * XSS on the registry origin): the four standard manifest types, plus JSON
 * flavors for custom artifact manifests.
 */
function isSafeManifestMediaType(mediaType: string): boolean {
  if (KNOWN_MANIFEST_TYPES.includes(mediaType)) return true;
  return /^application\/(json|[a-z0-9][a-z0-9!#$&^_.-]*\+json)$/i.test(mediaType);
}

/** Read the request body, failing fast once it exceeds `limit` bytes. */
async function readBodyLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

export async function handleManifestPut(
  env: Env,
  repo: string,
  reference: string,
  request: Request,
): Promise<Response> {
  const declared = Number(request.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_MANIFEST_SIZE) {
    return ociError(413, "MANIFEST_INVALID", "manifest too large");
  }
  const bytes = await readBodyLimited(request, MAX_MANIFEST_SIZE);
  if (bytes === null) {
    return ociError(413, "MANIFEST_INVALID", "manifest too large");
  }

  const digest = `sha256:${await sha256Hex(bytes)}`;

  const isDigestRef = looksLikeDigest(reference);
  if (isDigestRef) {
    const parsed = parseDigest(reference);
    if (!parsed?.supported || parsed.digest !== digest) {
      return ociError(400, "DIGEST_INVALID", undefined, {
        provided: reference,
        computed: digest,
      });
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return ociError(400, "MANIFEST_INVALID", "manifest is not valid JSON");
  }
  if (!isJsonObject(body)) {
    return ociError(400, "MANIFEST_INVALID", "manifest must be a JSON object");
  }

  // Content-Type header (parameters stripped) wins over body.mediaType.
  const headerType = request.headers.get("Content-Type")?.split(";")[0]?.trim();
  const bodyType = typeof body.mediaType === "string" ? body.mediaType : undefined;
  const mediaType = headerType || bodyType || MT_OCI_MANIFEST;
  if (!isSafeManifestMediaType(mediaType)) {
    return ociError(400, "MANIFEST_INVALID", "unsupported manifest media type", { mediaType });
  }

  const invalid = await verifyManifestReferences(env, repo, body, mediaType);
  if (invalid) return invalid;

  // The subject need not exist yet (referrers may land before their subject).
  let subjectDigest: string | null = null;
  const subjectRef = isJsonObject(body.subject) ? body.subject.digest : undefined;
  if (subjectRef !== undefined) {
    if (typeof subjectRef !== "string" || !parseDigest(subjectRef)) {
      return ociError(400, "MANIFEST_INVALID", "subject digest is invalid", {
        subject: subjectRef,
      });
    }
    subjectDigest = subjectRef;
  }

  const configType =
    isJsonObject(body.config) && typeof body.config.mediaType === "string"
      ? body.config.mediaType
      : null;
  const artifactType = typeof body.artifactType === "string" ? body.artifactType : configType;
  const annotations = isJsonObject(body.annotations) ? JSON.stringify(body.annotations) : null;

  await env.BUCKET.put(manifestKey(digest), bytes, {
    httpMetadata: { contentType: mediaType },
  });

  const now = Date.now();
  const statements = [
    env.DB.prepare("INSERT OR IGNORE INTO repositories (name, created_at) VALUES (?, ?)").bind(
      repo,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO manifests (repo, digest, media_type, artifact_type, subject_digest, annotations, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, digest) DO UPDATE SET
         media_type = excluded.media_type,
         artifact_type = excluded.artifact_type,
         subject_digest = excluded.subject_digest,
         annotations = excluded.annotations,
         size = excluded.size`,
    ).bind(repo, digest, mediaType, artifactType, subjectDigest, annotations, bytes.length, now),
  ];
  if (!isDigestRef) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO tags (repo, tag, digest, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(repo, tag) DO UPDATE SET digest = excluded.digest, updated_at = excluded.updated_at`,
      ).bind(repo, reference, digest, now),
    );
  }
  await env.DB.batch(statements);

  const headers = new Headers({
    Location: `/v2/${repo}/manifests/${digest}`,
    "Docker-Content-Digest": digest,
    "Content-Length": "0",
  });
  if (subjectDigest !== null) headers.set("OCI-Subject", subjectDigest);
  return new Response(null, { status: 201, headers });
}

export async function handleManifestGetOrHead(
  env: Env,
  repo: string,
  reference: string,
  request: Request,
): Promise<Response> {
  let digest: string;
  if (looksLikeDigest(reference)) {
    const parsed = parseDigest(reference);
    // Well-formed but unsupported algorithms read as unknown, not invalid.
    if (!parsed?.supported) {
      return ociError(404, "MANIFEST_UNKNOWN", undefined, { reference });
    }
    digest = parsed.digest;
  } else {
    const tagRow = await env.DB.prepare("SELECT digest FROM tags WHERE repo = ? AND tag = ?")
      .bind(repo, reference)
      .first<{ digest: string }>();
    if (!tagRow) return ociError(404, "MANIFEST_UNKNOWN", undefined, { reference });
    digest = tagRow.digest;
  }

  const row = await env.DB.prepare("SELECT * FROM manifests WHERE repo = ? AND digest = ?")
    .bind(repo, digest)
    .first<ManifestRow>();
  if (!row) return ociError(404, "MANIFEST_UNKNOWN", undefined, { reference });

  const headers = new Headers({
    "Content-Type": row.media_type ?? MT_OCI_MANIFEST,
    "Docker-Content-Digest": digest,
    "Content-Length": String(row.size),
    ETag: `"${digest}"`,
  });
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  const object = await env.BUCKET.get(manifestKey(digest));
  if (!object) return ociError(404, "MANIFEST_UNKNOWN", undefined, { reference });
  return new Response(object.body, { status: 200, headers });
}

export async function handleManifestDelete(
  env: Env,
  repo: string,
  reference: string,
): Promise<Response> {
  const accepted = () =>
    new Response(null, { status: 202, headers: { "Content-Length": "0" } });

  if (!looksLikeDigest(reference)) {
    const row = await env.DB.prepare("SELECT tag FROM tags WHERE repo = ? AND tag = ?")
      .bind(repo, reference)
      .first();
    if (!row) return ociError(404, "MANIFEST_UNKNOWN", undefined, { tag: reference });
    await env.DB.prepare("DELETE FROM tags WHERE repo = ? AND tag = ?").bind(repo, reference).run();
    return accepted();
  }

  const parsed = parseDigest(reference);
  if (!parsed?.supported) {
    return ociError(404, "MANIFEST_UNKNOWN", undefined, { digest: reference });
  }
  const digest = parsed.digest;
  const row = await env.DB.prepare("SELECT digest FROM manifests WHERE repo = ? AND digest = ?")
    .bind(repo, digest)
    .first();
  if (!row) return ociError(404, "MANIFEST_UNKNOWN", undefined, { digest });

  await env.DB.batch([
    env.DB.prepare("DELETE FROM manifests WHERE repo = ? AND digest = ?").bind(repo, digest),
    env.DB.prepare("DELETE FROM tags WHERE repo = ? AND digest = ?").bind(repo, digest),
  ]);

  // The R2 object is shared across repos and a concurrent PUT may re-reference
  // it, so it is never deleted inline — the GC pass removes manifest objects
  // whose digest no longer appears in the manifests table.
  return accepted();
}
