/**
 * Hono application: the OCI Distribution API (/v2/...), the health check, and
 * the dashboard fallback for every other path.
 *
 * Repository names may contain "/", so registry routes use Hono regex params
 * (`:name{.+}`): the greedy name match combined with each route's fixed
 * suffix (/blobs/..., /manifests/..., /tags/list, /referrers/...) anchors
 * parsing at the END of the path — the registry convention.
 *
 * The route layer owns identifier validation (name / tag / digest syntax);
 * handlers may assume syntactically valid identifiers.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./types";
import { ociError } from "./oci/errors";
import { isValidRepoName, isValidTag, looksLikeDigest, parseDigest } from "./oci/validation";
import type { Access, Principal } from "./auth";
import { authenticate, authorizeRepo, unauthorized } from "./auth";
import { handleAdmin } from "./dashboard/admin";
import { handleDashboard } from "./dashboard/index";
import { handleBlobDelete, handleBlobGetOrHead } from "./handlers/blobs";
import {
  handleUploadCancel,
  handleUploadChunk,
  handleUploadComplete,
  handleUploadStart,
  handleUploadStatus,
} from "./handlers/uploads";
import {
  handleManifestDelete,
  handleManifestGetOrHead,
  handleManifestPut,
} from "./handlers/manifests";
import { handleCatalog, handleTagsList } from "./handlers/tags";
import { handleReferrers } from "./handlers/referrers";

type AppEnv = { Bindings: Env; Variables: { principal: Principal } };

function methodNotAllowed(allowed: string[]): Response {
  return ociError(405, "UNSUPPORTED", "method not allowed", undefined, {
    Allow: allowed.join(", "),
  });
}

/** Validate a repo name or produce the spec error response. */
function checkName(name: string): Response | null {
  if (!isValidRepoName(name)) {
    return ociError(400, "NAME_INVALID", undefined, { name });
  }
  return null;
}

/**
 * Path param accessor. The shared Context type is not parameterized per route
 * path, so Hono types params as possibly-undefined; every use below names a
 * param its route actually declares.
 */
function param(c: Context<AppEnv>, key: string): string {
  return (c.req.param as (k: string) => string | undefined)(key) ?? "";
}

/**
 * Repository-route prologue: validate the `name` param, authorize the
 * principal against that repository at the given access level, then run `fn`.
 * "by-method" derives the level from the verb (GET/HEAD => read).
 */
function withRepo(
  access: Access | "by-method",
  fn: (c: Context<AppEnv>, name: string, url: URL) => Response | Promise<Response>,
): (c: Context<AppEnv>) => Response | Promise<Response> {
  return async (c) => {
    const name = param(c, "name");
    const bad = checkName(name);
    if (bad) return bad;
    const effective =
      access === "by-method"
        ? c.req.method === "GET" || c.req.method === "HEAD"
          ? "read"
          : "write"
        : access;
    const denied = await authorizeRepo(c.get("principal"), c.env, name, effective);
    if (denied) return denied;
    return fn(c, name, new URL(c.req.url));
  };
}

export const app = new Hono<AppEnv>({ strict: false });

// ---------------------------------------------------------------------------
// Auth: /healthz is open; everything else resolves a principal first (401 on
// invalid credentials). Authorization is per-route: repo routes check the
// repository's visibility, /admin requires the admin principal.
// ---------------------------------------------------------------------------
app.use("*", async (c, next) => {
  if (c.req.path === "/healthz") return next();
  const principal = await authenticate(c.req.raw, c.env);
  if (principal instanceof Response) return principal;
  c.set("principal", principal);
  await next();
  // Manifest media types (and anything else echoed as Content-Type) must never
  // be sniffed into something renderable on the registry origin.
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  // Workers only serve HTTPS, so pinning costs nothing and protects pulls
  // through downgrade-prone networks.
  c.res.headers.set("Strict-Transport-Security", "max-age=31536000");
  // Some clients sniff this header (on /v2/ and on errors) to confirm they are
  // talking to a v2 registry; the reference implementation sets it everywhere.
  if (c.req.path === "/v2" || c.req.path.startsWith("/v2/")) {
    c.res.headers.set("Docker-Distribution-API-Version", "registry/2.0");
  }
});

app.get("/healthz", (c) => c.text("ok"));

// ---------------------------------------------------------------------------
// OCI Distribution API
// ---------------------------------------------------------------------------

// API version check — also the endpoint `docker login` verifies credentials
// against, so anonymous requests get the Basic challenge.
app.on(["GET", "HEAD"], "/v2", (c) => {
  if (c.get("principal").kind === "anonymous") return unauthorized();
  return new Response("{}", {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Docker-Distribution-API-Version": "registry/2.0",
    },
  });
});

app.get("/v2/_catalog", (c) => handleCatalog(c.env, new URL(c.req.url), c.get("principal")));

// Upload sessions. Registered before the generic blob route so that
// ".../blobs/uploads/<id>" never parses as a blob digest.
// Upload sessions are part of the push flow, so every verb (the status GET
// included) requires write access.
app.post(
  "/v2/:name{.+}/blobs/uploads",
  withRepo("write", (c, name, url) => handleUploadStart(c.env, name, c.req.raw, url)),
);
app.get(
  "/v2/:name{.+}/blobs/uploads/:id",
  withRepo("write", (c, name) => handleUploadStatus(c.env, name, param(c, "id"))),
);
app.patch(
  "/v2/:name{.+}/blobs/uploads/:id",
  withRepo("write", (c, name) => handleUploadChunk(c.env, name, param(c, "id"), c.req.raw)),
);
app.put(
  "/v2/:name{.+}/blobs/uploads/:id",
  withRepo("write", (c, name, url) =>
    handleUploadComplete(c.env, name, param(c, "id"), c.req.raw, url),
  ),
);
app.delete(
  "/v2/:name{.+}/blobs/uploads/:id",
  withRepo("write", (c, name) => handleUploadCancel(c.env, name, param(c, "id"))),
);

// Blobs.
app.on(
  ["GET", "HEAD"],
  "/v2/:name{.+}/blobs/:digest",
  withRepo("read", (c, name) => {
    const digest = parseDigest(param(c, "digest"));
    if (!digest) {
      return ociError(400, "DIGEST_INVALID", undefined, { digest: param(c, "digest") });
    }
    return handleBlobGetOrHead(c.env, name, digest, c.req.raw);
  }),
);
app.delete(
  "/v2/:name{.+}/blobs/:digest",
  withRepo("write", (c, name) => {
    const digest = parseDigest(param(c, "digest"));
    if (!digest) {
      return ociError(400, "DIGEST_INVALID", undefined, { digest: param(c, "digest") });
    }
    return handleBlobDelete(c.env, name, digest);
  }),
);

// Manifests.
app.on(
  ["GET", "HEAD", "PUT", "DELETE"],
  "/v2/:name{.+}/manifests/:reference",
  withRepo("by-method", (c, name) => {
    const reference = param(c, "reference");
    if (looksLikeDigest(reference)) {
      if (!parseDigest(reference)) {
        return ociError(400, "DIGEST_INVALID", undefined, { digest: reference });
      }
    } else if (!isValidTag(reference)) {
      return ociError(400, "MANIFEST_INVALID", "invalid tag", { tag: reference });
    }
    switch (c.req.method) {
      case "PUT":
        return handleManifestPut(c.env, name, reference, c.req.raw);
      case "DELETE":
        return handleManifestDelete(c.env, name, reference);
      default:
        return handleManifestGetOrHead(c.env, name, reference, c.req.raw);
    }
  }),
);

// Content discovery.
app.get(
  "/v2/:name{.+}/tags/list",
  withRepo("read", (c, name, url) => handleTagsList(c.env, name, url)),
);
app.get(
  "/v2/:name{.+}/referrers/:digest",
  withRepo("read", (c, name, url) => {
    const digest = parseDigest(param(c, "digest"));
    if (!digest) {
      return ociError(400, "DIGEST_INVALID", undefined, { digest: param(c, "digest") });
    }
    return handleReferrers(c.env, name, digest, url);
  }),
);

// Known paths with an unsupported method => 405 + Allow (the method-specific
// routes above win for supported methods).
app.all("/v2", () => methodNotAllowed(["GET", "HEAD"]));
app.all("/v2/_catalog", () => methodNotAllowed(["GET"]));
app.all("/v2/:name{.+}/blobs/uploads", () => methodNotAllowed(["POST"]));
app.all("/v2/:name{.+}/blobs/uploads/:id", () =>
  methodNotAllowed(["GET", "PATCH", "PUT", "DELETE"]),
);
app.all("/v2/:name{.+}/blobs/:digest", () => methodNotAllowed(["GET", "HEAD", "DELETE"]));
app.all("/v2/:name{.+}/manifests/:reference", () =>
  methodNotAllowed(["GET", "HEAD", "PUT", "DELETE"]),
);
app.all("/v2/:name{.+}/tags/list", () => methodNotAllowed(["GET"]));
app.all("/v2/:name{.+}/referrers/:digest", () => methodNotAllowed(["GET"]));

// Anything else under /v2 is not an OCI endpoint.
app.all("/v2/*", () => ociError(404, "UNSUPPORTED", "unknown endpoint"));

// ---------------------------------------------------------------------------
// Admin dashboard (token issuance, repository visibility).
// ---------------------------------------------------------------------------
const adminRoute = (c: Context<AppEnv>): Promise<Response> =>
  handleAdmin(c.req.raw, c.env, new URL(c.req.url), c.get("principal"));
app.all("/admin", adminRoute);
app.all("/admin/*", adminRoute);

// ---------------------------------------------------------------------------
// Dashboard fallback for every non-/v2 path.
// ---------------------------------------------------------------------------
app.all("*", (c) => handleDashboard(c.req.raw, c.env, new URL(c.req.url), c.get("principal")));

app.onError((err, c) => {
  console.error(
    `unhandled error on ${c.req.method} ${c.req.path}:`,
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  return ociError(500, "UNSUPPORTED", "internal server error");
});
