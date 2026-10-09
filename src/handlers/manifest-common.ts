/**
 * Shared helpers for the manifest endpoints: JSON-shape guards and the
 * reference-existence verification run on manifest push.
 */

import type { Env } from "../types";
import { INDEX_MEDIA_TYPES } from "../types";
import { ociError } from "../oci/errors";
import { parseDigest } from "../oci/validation";

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** D1 allows at most 100 bound parameters per query. */
const D1_MAX_BINDS = 100;

/**
 * Return the subset of `digests` that exists in none of the given repo-scoped
 * tables for `repo`. Table names come from a closed union, never user input.
 */
export async function findMissingDigests(
  env: Env,
  repo: string,
  digests: readonly string[],
  tables: readonly ("manifests" | "repo_blobs")[],
): Promise<string[]> {
  const unique = [...new Set(digests)];
  if (unique.length === 0) return [];
  // Each table in the UNION binds (1 repo + chunk digests); size the chunk so
  // the statement stays within D1's bind limit for any table count.
  const chunkSize = Math.floor(D1_MAX_BINDS / tables.length) - 1;
  const found = new Set<string>();
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const sql = tables
      .map((table) => `SELECT digest FROM ${table} WHERE repo = ? AND digest IN (${placeholders})`)
      .join(" UNION ");
    const binds: string[] = [];
    for (const _ of tables) binds.push(repo, ...chunk);
    const rows = await env.DB.prepare(sql)
      .bind(...binds)
      .all<{ digest: string }>();
    for (const row of rows.results) found.add(row.digest);
  }
  return unique.filter((digest) => !found.has(digest));
}

/**
 * Verify the digests a manifest references, scoped to `repo`:
 * - index (mediaType in INDEX_MEDIA_TYPES, or an Array "manifests"): every
 *   child digest must parse and exist in `manifests`;
 * - image manifest (has config/layers): config + layer digests must parse and
 *   exist in `repo_blobs` or `manifests`, except foreign/nondistributable
 *   layers and layers carrying a "urls" array (clients fetch those elsewhere);
 * - any other shape is accepted without deep checks.
 *
 * Returns the error response to send, or null when the manifest is acceptable.
 */
export async function verifyManifestReferences(
  env: Env,
  repo: string,
  body: JsonObject,
  mediaType: string,
): Promise<Response | null> {
  if (INDEX_MEDIA_TYPES.includes(mediaType) || Array.isArray(body.manifests)) {
    const children: string[] = [];
    const entries = Array.isArray(body.manifests) ? body.manifests : [];
    for (const entry of entries) {
      const digest = isJsonObject(entry) ? entry.digest : undefined;
      if (typeof digest !== "string" || !parseDigest(digest)) {
        return ociError(400, "MANIFEST_INVALID", "index entry has an invalid digest", { digest });
      }
      children.push(digest);
    }
    const missing = await findMissingDigests(env, repo, children, ["manifests"]);
    if (missing.length > 0) {
      return ociError(400, "MANIFEST_BLOB_UNKNOWN", "index references unknown manifests", {
        missing,
      });
    }
    return null;
  }

  if (body.config === undefined && body.layers === undefined) return null;

  const required: string[] = [];
  if (body.config !== undefined) {
    const digest = isJsonObject(body.config) ? body.config.digest : undefined;
    if (typeof digest !== "string" || !parseDigest(digest)) {
      return ociError(400, "MANIFEST_INVALID", "config has an invalid digest", { digest });
    }
    required.push(digest);
  }
  const layers = Array.isArray(body.layers) ? body.layers : [];
  for (const entry of layers) {
    const layer = isJsonObject(entry) ? entry : {};
    const digest = layer.digest;
    if (typeof digest !== "string" || !parseDigest(digest)) {
      return ociError(400, "MANIFEST_INVALID", "layer has an invalid digest", { digest });
    }
    const layerType = typeof layer.mediaType === "string" ? layer.mediaType : "";
    const foreign =
      layerType.includes("nondistributable") ||
      layerType.includes("foreign") ||
      Array.isArray(layer.urls);
    if (!foreign) required.push(digest);
  }
  const missing = await findMissingDigests(env, repo, required, ["repo_blobs", "manifests"]);
  if (missing.length > 0) {
    return ociError(400, "MANIFEST_BLOB_UNKNOWN", undefined, { missing });
  }
  return null;
}
