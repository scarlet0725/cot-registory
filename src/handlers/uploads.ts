/**
 * Blob upload endpoints (OCI push flow).
 *
 * Storage strategy: chunks stream into an R2 multipart upload at
 * `staging/<id>` (one PATCH = one part; R2 requires uniform part sizes except
 * the last part, min 5 MiB). On the final PUT the staged object is copied to
 * its content address `blobs/<digest>` with R2's `sha256` put option doing
 * digest verification, then staging is cleaned up. Monolithic uploads
 * (POST?digest= or POST+PUT with full body) stream directly to
 * `blobs/<digest>` with the `sha256` option — no staging, no extra copy.
 * Session state lives in the `uploads` D1 table (see migrations/).
 *
 * POST /v2/<name>/blobs/uploads/
 *   - ?digest=: monolithic single-POST upload => 201 Location /v2/<name>/blobs/<digest>.
 *   - ?mount=<digest>[&from=<repo>]: link existing blob => 201 + Docker-Content-Digest;
 *     fall back to starting a session (202) when the blob is unknown.
 *   - otherwise: create session => 202, Location: /v2/<name>/blobs/uploads/<id>,
 *     Range: 0-0, Docker-Upload-UUID, OCI-Chunk-Min-Length: 5242880.
 *
 * GET /v2/<name>/blobs/uploads/<id>   => 204, Location, Range: 0-<received-1>, Docker-Upload-UUID.
 * PATCH                               => append chunk; validate Content-Range (416 on
 *                                        mismatch) and Content-Length; 202 + Range.
 * PUT ?digest=<digest>                => optional final body, complete + verify digest
 *                                        (400 DIGEST_INVALID on mismatch), record
 *                                        blobs/repo_blobs rows, 201 + Docker-Content-Digest.
 * DELETE                              => cancel session => 204.
 *
 * Unknown session id => 404 BLOB_UPLOAD_UNKNOWN.
 */

import type { Env, UploadRow } from "../types";
import { blobKey, stagingKey, MIN_CHUNK_SIZE } from "../types";
import { ociError } from "../oci/errors";
import { parseDigest } from "../oci/validation";
import type { ParsedDigest } from "../oci/validation";
import { blobLocation, commitBlob } from "./blob-common";

function uploadLocation(repo: string, id: string): string {
  return `/v2/${repo}/blobs/uploads/${id}`;
}

async function loadSession(env: Env, repo: string, id: string): Promise<UploadRow | null> {
  return env.DB.prepare("SELECT * FROM uploads WHERE id = ? AND repo = ?")
    .bind(id, repo)
    .first<UploadRow>();
}

async function deleteSession(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(id).run();
}

function sessionParts(session: UploadRow): R2UploadedPart[] {
  return JSON.parse(session.parts) as R2UploadedPart[];
}

/** Content-Length as a non-negative integer, or null when missing/invalid. */
function contentLength(request: Request): number | null {
  const raw = request.headers.get("Content-Length");
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Bodies with no Content-Length (chunked transfer encoding) are buffered up to
 * this cap so R2 gets the known length it requires. Larger streams must send
 * Content-Length (real docker/containerd/oras pushes always do).
 */
const MAX_BUFFERED_BODY = 32 * 1024 * 1024;

interface ResolvedBody {
  /** A known-length stream (Content-Length present) or fully buffered bytes. */
  data: ReadableStream<Uint8Array> | Uint8Array;
  length: number;
}

/**
 * Resolve the request body to a known length: trust Content-Length when
 * present (the runtime enforces it and R2 can consume the stream directly);
 * otherwise buffer up to MAX_BUFFERED_BODY. Returns a 411 error response for
 * unbounded streams past the cap.
 */
async function resolveBody(request: Request): Promise<ResolvedBody | Response> {
  const len = contentLength(request);
  if (len !== null) {
    return { data: request.body ?? new Uint8Array(0), length: len };
  }
  if (request.body === null) return { data: new Uint8Array(0), length: 0 };

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BUFFERED_BODY) {
      await reader.cancel();
      return ociError(
        411,
        "BLOB_UPLOAD_INVALID",
        `Content-Length is required for bodies larger than ${MAX_BUFFERED_BODY} bytes`,
      );
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { data, length: total };
}

/**
 * Part size used when splitting an unknown-length (chunked TE) PATCH body into
 * R2 multipart parts. Only one part is buffered in memory at a time, so the
 * total stream length is unbounded.
 */
const STREAM_PART_SIZE = 32 * 1024 * 1024;

interface StreamedParts {
  parts: R2UploadedPart[];
  total: number;
  lastPartSize: number;
  /** True when at least one full STREAM_PART_SIZE part was written. */
  hadFullPart: boolean;
}

/**
 * Split an unknown-length stream into uniform STREAM_PART_SIZE multipart parts
 * (plus a smaller final part), buffering one part at a time.
 */
async function uploadPartsFromStream(
  mpu: R2MultipartUpload,
  stream: ReadableStream<Uint8Array>,
  firstPartNumber: number,
): Promise<StreamedParts> {
  const parts: R2UploadedPart[] = [];
  let total = 0;
  let lastPartSize = 0;
  let partNumber = firstPartNumber;
  let buffer = new Uint8Array(STREAM_PART_SIZE);
  let filled = 0;

  const flush = async (bytes: Uint8Array) => {
    const part = await mpu.uploadPart(partNumber++, bytes);
    parts.push({ partNumber: part.partNumber, etag: part.etag });
    total += bytes.byteLength;
    lastPartSize = bytes.byteLength;
  };

  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let rest: Uint8Array = value;
    while (rest.byteLength > 0) {
      const take = Math.min(rest.byteLength, STREAM_PART_SIZE - filled);
      buffer.set(rest.subarray(0, take), filled);
      filled += take;
      rest = rest.subarray(take);
      if (filled === STREAM_PART_SIZE) {
        await flush(buffer);
        buffer = new Uint8Array(STREAM_PART_SIZE);
        filled = 0;
      }
    }
  }
  if (filled > 0) await flush(buffer.subarray(0, filled));

  return {
    parts,
    total,
    lastPartSize,
    hadFullPart: parts.length > 1 || lastPartSize === STREAM_PART_SIZE,
  };
}

/** R2 rejects a put whose sha256 option mismatches with a checksum error. */
function isChecksumError(err: unknown): boolean {
  return err instanceof Error && /checksum|sha-?256/i.test(err.message);
}

/** Stay well under R2's ~4.995 GiB cap for a single put call. */
const SINGLE_PUT_LIMIT = 4 * 1024 * 1024 * 1024;
/** Ranged-get part size for the multipart copy of very large staged blobs. */
const COPY_PART_SIZE = 256 * 1024 * 1024;

/**
 * Copy the staged object to its content address, verifying the digest.
 * Small objects go through one R2 put with the sha256 option; objects past the
 * single-put cap are hashed with DigestStream first, then copied via a second
 * multipart upload fed by ranged gets (streamed, nothing buffered).
 * Returns "mismatch" for a digest failure; throws on other storage errors.
 */
async function copyStagedToBlob(
  env: Env,
  r2Key: string,
  digest: ParsedDigest,
  size: number,
): Promise<"ok" | "mismatch"> {
  if (size <= SINGLE_PUT_LIMIT) {
    const staged = await env.BUCKET.get(r2Key);
    if (!staged) throw new Error("staged upload object missing");
    try {
      const fixed = new FixedLengthStream(size);
      const pipePromise = staged.body.pipeTo(fixed.writable);
      await Promise.all([
        env.BUCKET.put(blobKey(digest.digest), fixed.readable, { sha256: digest.encoded }),
        pipePromise,
      ]);
      return "ok";
    } catch (err) {
      if (isChecksumError(err)) return "mismatch";
      throw err;
    }
  }

  // Verification pass: R2's sha256 option is unavailable for multipart, so
  // hash the staged content in the Worker before copying.
  const staged = await env.BUCKET.get(r2Key);
  if (!staged) throw new Error("staged upload object missing");
  const hasher = new crypto.DigestStream("SHA-256");
  await staged.body.pipeTo(hasher);
  const hex = [...new Uint8Array(await hasher.digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (hex !== digest.encoded) return "mismatch";

  const target = await env.BUCKET.createMultipartUpload(blobKey(digest.digest));
  try {
    const parts: R2UploadedPart[] = [];
    let partNumber = 1;
    for (let offset = 0; offset < size; offset += COPY_PART_SIZE) {
      const length = Math.min(COPY_PART_SIZE, size - offset);
      const slice = await env.BUCKET.get(r2Key, { range: { offset, length } });
      if (!slice) throw new Error("staged upload object disappeared during copy");
      const part = await target.uploadPart(partNumber++, slice.body);
      parts.push({ partNumber: part.partNumber, etag: part.etag });
    }
    await target.complete(parts);
    return "ok";
  } catch (err) {
    try {
      await target.abort();
    } catch {
      // Best effort; an aborted target upload holds no visible object.
    }
    throw err;
  }
}

/** 202 Accepted for an open session (POST without digest, PATCH, GET fallback). */
function accepted(repo: string, id: string, bytesReceived: number): Response {
  return new Response(null, {
    status: 202,
    headers: {
      Location: uploadLocation(repo, id),
      Range: `0-${Math.max(bytesReceived - 1, 0)}`,
      "Docker-Upload-UUID": id,
      "OCI-Chunk-Min-Length": String(MIN_CHUNK_SIZE),
      "Content-Length": "0",
    },
  });
}

/** 201 Created for a committed blob (monolithic POST, mount, PUT completion). */
function created(repo: string, digest: string): Response {
  return new Response(null, {
    status: 201,
    headers: {
      Location: blobLocation(repo, digest),
      "Docker-Content-Digest": digest,
      "Content-Length": "0",
    },
  });
}

/** Best-effort removal of the staged object and session row. */
async function cleanupStaging(env: Env, session: UploadRow): Promise<void> {
  try {
    await env.BUCKET.delete(session.r2_key);
  } catch {
    // Best effort; GC sweeps stale staging objects.
  }
  await deleteSession(env, session.id);
}

/** Monolithic single-POST upload: stream the body straight to its content address. */
async function monolithicUpload(
  env: Env,
  repo: string,
  request: Request,
  digestParam: string,
): Promise<Response> {
  const digest = parseDigest(digestParam);
  if (!digest) return ociError(400, "DIGEST_INVALID", undefined, { digest: digestParam });
  if (!digest.supported) {
    return ociError(400, "UNSUPPORTED", "only sha256 digests are supported", {
      digest: digestParam,
    });
  }
  const resolved = await resolveBody(request);
  if (resolved instanceof Response) return resolved;

  try {
    // R2 put with the sha256 option rejects on digest mismatch.
    const body = resolved.length === 0 ? new Uint8Array(0) : resolved.data;
    await env.BUCKET.put(blobKey(digest.digest), body, { sha256: digest.encoded });
  } catch (err) {
    // Only checksum rejections are the client's fault; transient storage
    // failures must stay retryable (5xx via the app-level error handler).
    if (!isChecksumError(err)) throw err;
    return ociError(400, "DIGEST_INVALID", undefined, { digest: digest.digest });
  }
  await commitBlob(env, repo, digest.digest, resolved.length);
  return created(repo, digest.digest);
}

export async function handleUploadStart(
  env: Env,
  repo: string,
  request: Request,
  url: URL,
): Promise<Response> {
  const digestParam = url.searchParams.get("digest");
  if (digestParam !== null) return monolithicUpload(env, repo, request, digestParam);

  const mountParam = url.searchParams.get("mount");
  if (mountParam !== null) {
    // Blobs are content-addressed and global, so `from=` is not needed.
    const digest = parseDigest(mountParam);
    if (digest?.supported) {
      const row = await env.DB.prepare("SELECT size FROM blobs WHERE digest = ?")
        .bind(digest.digest)
        .first<{ size: number }>();
      if (row) {
        await commitBlob(env, repo, digest.digest, row.size);
        return created(repo, digest.digest);
      }
    }
    // Unknown or unsupported digest: fall through to a regular session, per spec.
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO uploads (id, repo, r2_key, bytes_received, parts, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', ?, ?)",
    ).bind(id, repo, stagingKey(id), now, now),
    env.DB.prepare("INSERT OR IGNORE INTO repositories (name, created_at) VALUES (?, ?)").bind(
      repo,
      now,
    ),
  ]);
  return accepted(repo, id, 0);
}

export async function handleUploadStatus(
  env: Env,
  repo: string,
  uploadId: string,
): Promise<Response> {
  const session = await loadSession(env, repo, uploadId);
  if (!session) return ociError(404, "BLOB_UPLOAD_UNKNOWN", undefined, { id: uploadId });
  return new Response(null, {
    status: 204,
    headers: {
      Location: uploadLocation(repo, session.id),
      Range: `0-${Math.max(session.bytes_received - 1, 0)}`,
      "Docker-Upload-UUID": session.id,
    },
  });
}

export async function handleUploadChunk(
  env: Env,
  repo: string,
  uploadId: string,
  request: Request,
): Promise<Response> {
  const session = await loadSession(env, repo, uploadId);
  if (!session) return ociError(404, "BLOB_UPLOAD_UNKNOWN", undefined, { id: uploadId });

  const len = contentLength(request);

  const contentRange = request.headers.get("Content-Range");
  if (contentRange !== null) {
    const m = /^(\d+)-(\d+)$/.exec(contentRange.trim());
    if (!m) {
      return ociError(400, "BLOB_UPLOAD_INVALID", "malformed Content-Range header", {
        contentRange,
      });
    }
    const start = Number(m[1]!);
    const end = Number(m[2]!);
    if (start !== session.bytes_received) {
      return ociError(416, "BLOB_UPLOAD_INVALID", "range does not match current offset", {
        expected: session.bytes_received,
        received: start,
      });
    }
    if (len !== null && end - start + 1 !== len) {
      return ociError(400, "SIZE_INVALID", "Content-Range length does not match Content-Length");
    }
  }

  const firstChunk = session.r2_upload_id === null;
  const partSize = session.part_size ?? 0;
  if (!firstChunk) {
    if (session.last_part_size !== null && session.last_part_size < partSize) {
      return ociError(
        400,
        "BLOB_UPLOAD_INVALID",
        "previous chunk was smaller than the first chunk; R2 requires uniform chunk sizes (except the last)",
      );
    }
    if (partSize < MIN_CHUNK_SIZE) {
      return ociError(
        400,
        "BLOB_UPLOAD_INVALID",
        "chunks must be at least 5 MiB except the final chunk",
      );
    }
  }

  const parts = sessionParts(session);

  // --- Unknown length (chunked transfer encoding): split the stream into
  // uniform STREAM_PART_SIZE parts. This is how docker/podman push layers that
  // are gzip-compressed on the fly.
  if (len === null) {
    if (request.body === null) return accepted(repo, session.id, session.bytes_received);
    if (!firstChunk && partSize !== STREAM_PART_SIZE) {
      return ociError(
        400,
        "BLOB_UPLOAD_INVALID",
        "cannot mix fixed-size chunks with chunked-transfer streaming in one upload",
      );
    }
    const mpu = firstChunk
      ? await env.BUCKET.createMultipartUpload(session.r2_key)
      : env.BUCKET.resumeMultipartUpload(session.r2_key, session.r2_upload_id!);
    const streamed = await uploadPartsFromStream(mpu, request.body, parts.length + 1);
    if (streamed.total === 0) {
      // Nothing arrived; keep the session untouched (but record the upload id
      // if we just created the multipart upload).
      if (firstChunk) {
        await env.DB.prepare("UPDATE uploads SET r2_upload_id = ?, updated_at = ? WHERE id = ?")
          .bind(mpu.uploadId, Date.now(), session.id)
          .run();
      }
      return accepted(repo, session.id, session.bytes_received);
    }
    parts.push(...streamed.parts);
    const bytesReceived = session.bytes_received + streamed.total;
    await env.DB.prepare(
      "UPDATE uploads SET r2_upload_id = ?, bytes_received = ?, part_size = ?, last_part_size = ?, parts = ?, updated_at = ? WHERE id = ?",
    )
      .bind(
        mpu.uploadId,
        bytesReceived,
        firstChunk ? (streamed.hadFullPart ? STREAM_PART_SIZE : streamed.lastPartSize) : partSize,
        streamed.lastPartSize,
        JSON.stringify(parts),
        Date.now(),
        session.id,
      )
      .run();
    return accepted(repo, session.id, bytesReceived);
  }

  // --- Known length: one PATCH = one part, streamed straight to R2.
  if (len === 0) return accepted(repo, session.id, session.bytes_received);
  if (!firstChunk && len > partSize) {
    return ociError(400, "SIZE_INVALID", "chunk larger than first chunk");
  }

  const mpu = firstChunk
    ? await env.BUCKET.createMultipartUpload(session.r2_key)
    : env.BUCKET.resumeMultipartUpload(session.r2_key, session.r2_upload_id!);

  // The Content-Length header gives the stream a known length, which R2 requires.
  const part = await mpu.uploadPart(parts.length + 1, request.body ?? new Uint8Array(0));
  parts.push({ partNumber: part.partNumber, etag: part.etag });

  const bytesReceived = session.bytes_received + len;
  await env.DB.prepare(
    "UPDATE uploads SET r2_upload_id = ?, bytes_received = ?, part_size = ?, last_part_size = ?, parts = ?, updated_at = ? WHERE id = ?",
  )
    .bind(
      mpu.uploadId,
      bytesReceived,
      firstChunk ? len : partSize,
      len,
      JSON.stringify(parts),
      Date.now(),
      session.id,
    )
    .run();

  return accepted(repo, session.id, bytesReceived);
}

export async function handleUploadComplete(
  env: Env,
  repo: string,
  uploadId: string,
  request: Request,
  url: URL,
): Promise<Response> {
  const session = await loadSession(env, repo, uploadId);
  if (!session) return ociError(404, "BLOB_UPLOAD_UNKNOWN", undefined, { id: uploadId });

  const digestParam = url.searchParams.get("digest");
  if (digestParam === null) {
    return ociError(400, "DIGEST_INVALID", "digest query parameter required");
  }
  const digest = parseDigest(digestParam);
  if (!digest) return ociError(400, "DIGEST_INVALID", undefined, { digest: digestParam });
  if (!digest.supported) {
    return ociError(400, "UNSUPPORTED", "only sha256 digests are supported", {
      digest: digestParam,
    });
  }

  const resolved = await resolveBody(request);
  if (resolved instanceof Response) return resolved;
  const len = resolved.length;

  // (a) Nothing staged yet (classic POST + single PUT, or the empty blob):
  // stream the body straight to its content address.
  if (session.r2_upload_id === null) {
    try {
      const body = len === 0 ? new Uint8Array(0) : resolved.data;
      await env.BUCKET.put(blobKey(digest.digest), body, { sha256: digest.encoded });
    } catch (err) {
      if (!isChecksumError(err)) throw err;
      return ociError(400, "DIGEST_INVALID", undefined, { digest: digest.digest });
    }
    await commitBlob(env, repo, digest.digest, len);
    await deleteSession(env, session.id);
    return created(repo, digest.digest);
  }

  const parts = sessionParts(session);
  const mpu = env.BUCKET.resumeMultipartUpload(session.r2_key, session.r2_upload_id);

  // (b) A final body arrives with the PUT: upload it as the last part.
  if (len > 0) {
    const partSize = session.part_size ?? 0;
    if (session.last_part_size !== null && session.last_part_size < partSize) {
      return ociError(
        400,
        "BLOB_UPLOAD_INVALID",
        "previous chunk was smaller than the first chunk; R2 requires uniform chunk sizes (except the last)",
      );
    }
    if (len > partSize) {
      return ociError(400, "SIZE_INVALID", "final chunk larger than first chunk");
    }
    const part = await mpu.uploadPart(parts.length + 1, resolved.data);
    parts.push({ partNumber: part.partNumber, etag: part.etag });
  }

  // (b)/(c) Assemble the staged object. R2 rejects part-size violations here.
  try {
    await mpu.complete(parts);
  } catch (err) {
    // A retried PUT hits "upload does not exist" after an earlier PUT already
    // completed the multipart upload; the staged object is intact then, so
    // fall through to the copy instead of destroying it.
    const alreadyStaged = await env.BUCKET.head(session.r2_key);
    if (!alreadyStaged) {
      try {
        await mpu.abort();
      } catch {
        // Best effort; the upload may already be gone.
      }
      await cleanupStaging(env, session);
      return ociError(
        400,
        "BLOB_UPLOAD_INVALID",
        err instanceof Error ? err.message : "multipart completion failed",
      );
    }
  }

  const staged = await env.BUCKET.head(session.r2_key);
  if (!staged) {
    await deleteSession(env, session.id);
    return ociError(500, "UNSUPPORTED", "staged upload object missing");
  }

  // Copy staging -> content address with digest verification. Storage errors
  // other than a digest mismatch propagate as 5xx and keep the session, so the
  // client can retry the PUT (the completed staging survives, see above).
  const copied = await copyStagedToBlob(env, session.r2_key, digest, staged.size);
  if (copied === "mismatch") {
    await cleanupStaging(env, session);
    return ociError(400, "DIGEST_INVALID", undefined, { digest: digest.digest });
  }

  await commitBlob(env, repo, digest.digest, staged.size);
  await env.BUCKET.delete(session.r2_key);
  await deleteSession(env, session.id);
  return created(repo, digest.digest);
}

export async function handleUploadCancel(
  env: Env,
  repo: string,
  uploadId: string,
): Promise<Response> {
  const session = await loadSession(env, repo, uploadId);
  if (!session) return ociError(404, "BLOB_UPLOAD_UNKNOWN", undefined, { id: uploadId });

  if (session.r2_upload_id !== null) {
    try {
      await env.BUCKET.resumeMultipartUpload(session.r2_key, session.r2_upload_id).abort();
    } catch {
      // The multipart upload may already be aborted or completed.
    }
  }
  try {
    await env.BUCKET.delete(session.r2_key);
  } catch {
    // Best effort.
  }
  await deleteSession(env, session.id);
  return new Response(null, { status: 204, headers: { "Content-Length": "0" } });
}
