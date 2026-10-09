/**
 * Helpers shared by the blob pull (blobs.ts) and push (uploads.ts) handlers.
 */

import type { Env } from "../types";

/** Canonical URL path of a blob within a repository. */
export function blobLocation(repo: string, digest: string): string {
  return `/v2/${repo}/blobs/${digest}`;
}

/**
 * Record a completed blob: the global content-addressed index (`blobs`), the
 * per-repo visibility link (`repo_blobs`), and the repository itself. All
 * INSERT OR IGNORE, so re-pushing or re-mounting an existing blob is a no-op.
 * Shared by monolithic POST, PUT completion, and cross-repo mount.
 */
export async function commitBlob(
  env: Env,
  repo: string,
  digest: string,
  size: number,
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO blobs (digest, size, created_at) VALUES (?, ?, ?)").bind(
      digest,
      size,
      now,
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO repo_blobs (repo, digest, created_at) VALUES (?, ?, ?)",
    ).bind(repo, digest, now),
    env.DB.prepare("INSERT OR IGNORE INTO repositories (name, created_at) VALUES (?, ?)").bind(
      repo,
      now,
    ),
  ]);
}
