/**
 * Validation helpers for OCI Distribution Spec identifiers.
 */

/** Repository name, per distribution-spec (lowercase path segments). */
const NAME_RE = /^[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*(\/[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*)*$/;

/** Tag reference. */
const TAG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

/** Generic digest grammar: algorithm ":" encoded. */
const DIGEST_RE = /^([a-z0-9]+(?:[.+_-][a-z0-9]+)*):([a-zA-Z0-9=_-]+)$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export function isValidRepoName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && NAME_RE.test(name);
}

export function isValidTag(tag: string): boolean {
  return TAG_RE.test(tag);
}

export interface ParsedDigest {
  /** Full digest string, e.g. "sha256:abc...". */
  digest: string;
  algorithm: string;
  encoded: string;
  /** True when algorithm is sha256 with a well-formed hex encoding. */
  supported: boolean;
}

/**
 * Parse a digest string. Returns null when the string does not match the
 * digest grammar at all (=> DIGEST_INVALID). A well-formed digest with an
 * algorithm other than sha256 parses with `supported: false` — handlers
 * treat those as unknown (reads) or unsupported (writes).
 */
export function parseDigest(value: string): ParsedDigest | null {
  const m = DIGEST_RE.exec(value);
  if (!m) return null;
  const algorithm = m[1]!;
  const encoded = m[2]!;
  const supported = algorithm === "sha256" && SHA256_HEX_RE.test(encoded);
  if (algorithm === "sha256" && !supported) return null; // sha256 with bad hex is malformed
  return { digest: value, algorithm, encoded, supported };
}

/** Looks like a digest attempt (contains ":") rather than a tag. */
export function looksLikeDigest(reference: string): boolean {
  return reference.includes(":");
}

/** SHA-256 of `data`, as a lowercase hex string. */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    data instanceof Uint8Array ? (data as Uint8Array<ArrayBuffer>) : new Uint8Array(data),
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
