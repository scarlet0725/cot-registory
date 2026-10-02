/**
 * HTTP Basic authentication.
 *
 * Modes:
 * - REGISTRY_USERNAME + REGISTRY_PASSWORD unset => OPEN mode (everything allowed; local dev).
 * - Both set => Basic auth required. PUBLIC_READ === "true" exempts `read` access.
 *
 * Returns null when the request is allowed, or a 401 Response with a
 * `WWW-Authenticate: Basic realm="cot"` challenge and an OCI UNAUTHORIZED
 * error body otherwise. Credential comparison must be constant-time
 * (hash both sides with SHA-256, then crypto.subtle.timingSafeEqual).
 */

import type { Env } from "./types";
import { ociError } from "./oci/errors";

export type Access = "read" | "write";

/** The 401 challenge every denied request receives. */
function unauthorized(): Response {
  return ociError(401, "UNAUTHORIZED", "authentication required", undefined, {
    "WWW-Authenticate": 'Basic realm="cot", charset="UTF-8"',
  });
}

/**
 * Constant-time string comparison: hash both sides to equal-length digests,
 * then compare with the Workers timingSafeEqual extension. Hashing first means
 * neither string length nor content position leaks through timing.
 */
async function secureEquals(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export async function authorize(
  request: Request,
  env: Env,
  access: Access,
): Promise<Response | null> {
  const username = env.REGISTRY_USERNAME;
  const password = env.REGISTRY_PASSWORD;

  // OPEN mode: no credentials configured at all.
  if (!username && !password) return null;

  // Exactly one of the pair set is a misconfiguration: fail closed, even for reads.
  if (!username || !password) return unauthorized();

  if (env.PUBLIC_READ === "true" && access === "read") return null;

  const header = request.headers.get("Authorization");
  if (!header) return unauthorized();
  const space = header.indexOf(" ");
  if (space < 0 || header.slice(0, space).toLowerCase() !== "basic") {
    return unauthorized();
  }

  // atob yields one char per raw byte (Latin-1); decode those bytes as UTF-8
  // so non-ASCII credentials compare correctly (RFC 7617 charset="UTF-8").
  let decoded: string;
  try {
    const binary = atob(header.slice(space + 1).trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    decoded = new TextDecoder("utf-8").decode(bytes);
  } catch {
    return unauthorized();
  }

  // Split at the FIRST ":" only — passwords may contain ":".
  const colon = decoded.indexOf(":");
  if (colon < 0) return unauthorized();
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);

  // Evaluate both comparisons unconditionally (no short-circuit timing leak).
  const [userOk, passOk] = await Promise.all([
    secureEquals(user, username),
    secureEquals(pass, password),
  ]);
  return userOk && passOk ? null : unauthorized();
}
