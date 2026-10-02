/**
 * Referrers API (OCI distribution-spec v1.1).
 *
 * GET /v2/<name>/referrers/<digest>?artifactType=<mt>
 *   - Query `manifests` where repo = <name> AND subject_digest = <digest>.
 *   - Respond 200 with an OCI image index (even when empty):
 *     { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json",
 *       manifests: [ { mediaType, digest, size, artifactType?, annotations? } ] }
 *   - Content-Type: application/vnd.oci.image.index.v1+json.
 *   - ?artifactType= filters on the stored artifact_type and adds the
 *     response header `OCI-Filters-Applied: artifactType`.
 */

import type { Env, ManifestRow } from "../types";
import { MT_OCI_INDEX, MT_OCI_MANIFEST } from "../types";
import type { ParsedDigest } from "../oci/validation";

interface ReferrerDescriptor {
  mediaType: string;
  digest: string;
  size: number;
  artifactType?: string;
  annotations?: unknown;
}

export async function handleReferrers(
  env: Env,
  repo: string,
  digest: ParsedDigest,
  url: URL,
): Promise<Response> {
  const artifactTypeFilter = url.searchParams.get("artifactType");

  // Unsupported algorithms (and unknown repos) still get an empty index.
  let descriptors: ReferrerDescriptor[] = [];
  if (digest.supported) {
    const rows = await env.DB.prepare(
      "SELECT * FROM manifests WHERE repo = ? AND subject_digest = ? ORDER BY created_at",
    )
      .bind(repo, digest.digest)
      .all<ManifestRow>();
    let results = rows.results;
    if (artifactTypeFilter !== null) {
      results = results.filter((row) => row.artifact_type === artifactTypeFilter);
    }
    descriptors = results.map((row) => {
      const descriptor: ReferrerDescriptor = {
        mediaType: row.media_type ?? MT_OCI_MANIFEST,
        digest: row.digest,
        size: row.size,
      };
      if (row.artifact_type !== null) descriptor.artifactType = row.artifact_type;
      if (row.annotations !== null) {
        try {
          descriptor.annotations = JSON.parse(row.annotations);
        } catch {
          // Annotations are stored as JSON by manifest push; a malformed
          // value is dropped rather than failing the whole listing.
        }
      }
      return descriptor;
    });
  }

  const headers = new Headers({ "Content-Type": MT_OCI_INDEX });
  // Set whenever the query param is present, even when nothing matches.
  if (artifactTypeFilter !== null) headers.set("OCI-Filters-Applied", "artifactType");

  const body = { schemaVersion: 2, mediaType: MT_OCI_INDEX, manifests: descriptors };
  return new Response(JSON.stringify(body), { status: 200, headers });
}
