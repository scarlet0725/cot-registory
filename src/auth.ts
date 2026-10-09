/**
 * Authentication & authorization.
 *
 * Principals:
 * - OPEN mode: ADMIN_USERNAME + ADMIN_PASSWORD both unset => everything is
 *   allowed (local dev only).
 * - admin: Basic auth with the env admin pair. Manages tokens and repository
 *   visibility at /admin; also has full registry access.
 * - credential: Basic auth with an issued token (username = token id,
 *   password = secret). Full /v2 read/write. Tokens are issued/revoked in the
 *   /admin dashboard and stored in D1 as SHA-256 hashes (`credentials`).
 * - anonymous: no Authorization header. May read repositories whose
 *   visibility is 'public'; everything else is denied.
 *
 * Presenting *invalid* credentials never degrades to anonymous: the request
 * gets a 401 with a `WWW-Authenticate: Basic` challenge and an OCI
 * UNAUTHORIZED error body. Credential comparison must be constant-time
 * (hash both sides with SHA-256, then crypto.subtle.timingSafeEqual).
 */

import type { Env } from "./types";
import { ociError } from "./oci/errors";

export type Access = "read" | "write";

export type Principal =
  | { kind: "open" }
  | { kind: "admin" }
  | { kind: "credential"; id: string }
  | { kind: "anonymous" };

export const BASIC_CHALLENGE = 'Basic realm="cot", charset="UTF-8"';

/** `last_used_at` is tracked at this granularity to avoid a write per request. */
const LAST_USED_GRANULARITY_MS = 60 * 60 * 1000;

/** SHA-256 of "" — compared against when the token id matches no row. */
const DUMMY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** The 401 challenge every denied request receives. */
export function unauthorized(): Response {
  return ociError(401, "UNAUTHORIZED", "authentication required", undefined, {
    "WWW-Authenticate": BASIC_CHALLENGE,
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

/** Lowercase hex SHA-256 of a UTF-8 string (token secret hashing). */
export async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Parse a Basic Authorization header into user/pass, or null when malformed. */
function parseBasicAuth(header: string): { user: string; pass: string } | null {
  const space = header.indexOf(" ");
  if (space < 0 || header.slice(0, space).toLowerCase() !== "basic") return null;

  // atob yields one char per raw byte (Latin-1); decode those bytes as UTF-8
  // so non-ASCII credentials compare correctly (RFC 7617 charset="UTF-8").
  let decoded: string;
  try {
    const binary = atob(header.slice(space + 1).trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    decoded = new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }

  // Split at the FIRST ":" only — passwords may contain ":".
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
}

interface CredentialAuthRow {
  id: string;
  secret_hash: string;
  last_used_at: number | null;
}

/**
 * Resolve the request's principal, or a 401 Response when credentials were
 * presented but are malformed or invalid.
 */
export async function authenticate(request: Request, env: Env): Promise<Principal | Response> {
  const adminUser = env.ADMIN_USERNAME;
  const adminPass = env.ADMIN_PASSWORD;

  // OPEN mode: no admin credentials configured at all.
  if (!adminUser && !adminPass) return { kind: "open" };

  // Exactly one of the pair set is a misconfiguration: fail closed.
  if (!adminUser || !adminPass) return unauthorized();

  const header = request.headers.get("Authorization");
  if (!header) return { kind: "anonymous" };

  const creds = parseBasicAuth(header);
  if (!creds) return unauthorized();

  // Evaluate the admin comparison AND the token lookup unconditionally, so
  // timing does not reveal which usernames exist.
  const [row, providedHash] = await Promise.all([
    env.DB.prepare("SELECT id, secret_hash, last_used_at FROM credentials WHERE id = ?")
      .bind(creds.user)
      .first<CredentialAuthRow>(),
    sha256Hex(creds.pass),
  ]);
  const [adminUserOk, adminPassOk, tokenOk] = await Promise.all([
    secureEquals(creds.user, adminUser),
    secureEquals(creds.pass, adminPass),
    secureEquals(providedHash, row?.secret_hash ?? DUMMY_HASH),
  ]);

  if (adminUserOk && adminPassOk) return { kind: "admin" };

  if (row && tokenOk) {
    const now = Date.now();
    if (row.last_used_at === null || now - row.last_used_at > LAST_USED_GRANULARITY_MS) {
      await env.DB.prepare("UPDATE credentials SET last_used_at = ? WHERE id = ?")
        .bind(now, row.id)
        .run();
    }
    return { kind: "credential", id: row.id };
  }

  // Visible in Workers Logs so brute-force attempts can be spotted and the
  // targeted token revoked. Never log the presented secret or username — a
  // password pasted into the username field must not end up in logs.
  console.warn(row ? `auth: bad secret for token ${row.id}` : "auth: invalid credentials");
  return unauthorized();
}

/** May anonymous clients read `repo`? (Missing repos read as not-public, so
 * their existence never leaks to anonymous clients.) */
export async function anonymousCanRead(env: Env, repo: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT visibility FROM repositories WHERE name = ?")
    .bind(repo)
    .first<{ visibility: string }>();
  return row?.visibility === "public";
}

/**
 * Per-repository authorization. Any authenticated principal (admin or issued
 * token) has full access; anonymous requests may only read public repos.
 * Returns null when allowed, or the 401 Response.
 */
export async function authorizeRepo(
  principal: Principal,
  env: Env,
  repo: string,
  access: Access,
): Promise<Response | null> {
  if (principal.kind !== "anonymous") return null;
  if (access === "write") return unauthorized();
  return (await anonymousCanRead(env, repo)) ? null : unauthorized();
}
