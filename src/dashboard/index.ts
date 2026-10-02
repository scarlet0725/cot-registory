/**
 * Lightweight dashboard (zot-style), served on all non-/v2 paths.
 *
 * Routes:
 *   GET /                      repository list (tag count, storage size, last updated)
 *   GET /r/<name>              repo detail: tags (digest, media type, updated), untagged manifests
 *   GET /r/<name>/m/<digest>   manifest detail: parsed layers/config/platforms, referrers,
 *                              raw JSON, pull command
 *   GET /favicon.svg           inline SVG icon
 *   anything else              404 page
 *
 * Constraints: server-rendered HTML only, zero external assets (inline CSS),
 * dark/light via prefers-color-scheme, all dynamic strings HTML-escaped.
 * Data comes from D1 (see migrations/) and manifest JSON from R2.
 */

import type { Env } from "../types";
import { isValidRepoName, parseDigest } from "../oci/validation";
import { pageResponse } from "./html";
import {
  errorResponse,
  renderHomePage,
  renderManifestPage,
  renderRepoPage,
} from "./pages";

/** Simple isometric container/box glyph. */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#2f81f7" d="M16 2 29 9.5v13L16 30 3 22.5v-13z"/><path fill="#9ec7ff" d="M16 2 29 9.5 16 17 3 9.5z"/><path fill="#1158c7" d="M16 17v13L3 22.5v-13z"/></svg>`;

/**
 * Split a pathname into decoded, non-empty segments.
 * Returns null on malformed percent-encoding.
 */
function splitPath(pathname: string): string[] | null {
  const segments: string[] = [];
  for (const raw of pathname.split("/")) {
    if (raw === "") continue;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  return segments;
}

function notFound(env: Env, method: string, url: URL): Response {
  return errorResponse(
    env,
    method,
    404,
    "Page not found",
    `The path ${url.pathname} does not exist on this registry.`,
  );
}

export async function handleDashboard(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const method = request.method;

  if (method !== "GET" && method !== "HEAD") {
    return errorResponse(
      env,
      method,
      405,
      "Method not allowed",
      `${method} is not supported by the dashboard.`,
      { Allow: "GET, HEAD" },
    );
  }

  const segments = splitPath(url.pathname);
  if (segments === null) return notFound(env, method, url);

  // GET /
  if (segments.length === 0) {
    return pageResponse(method, await renderHomePage(env, url));
  }

  // GET /favicon.svg
  if (segments.length === 1 && segments[0] === "favicon.svg") {
    return new Response(method === "HEAD" ? null : FAVICON_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=604800, immutable",
      },
    });
  }

  if (segments[0] === "r" && segments.length >= 2) {
    // GET /r/<name>/m/<digest> — parsed from the end, since <name> may
    // contain slashes: last segment is the digest, the one before is "m".
    if (segments.length >= 4 && segments[segments.length - 2] === "m") {
      const digest = segments[segments.length - 1] ?? "";
      const repo = segments.slice(1, segments.length - 2).join("/");
      if (!isValidRepoName(repo) || parseDigest(digest) === null) {
        return notFound(env, method, url);
      }
      const page = await renderManifestPage(env, url, repo, digest);
      if (page === null) {
        return errorResponse(
          env,
          method,
          404,
          "Manifest not found",
          `No manifest ${digest} in repository ${repo}.`,
        );
      }
      return pageResponse(method, page);
    }

    // GET /r/<name>
    const repo = segments.slice(1).join("/");
    if (!isValidRepoName(repo)) return notFound(env, method, url);
    const page = await renderRepoPage(env, url, repo);
    if (page === null) {
      return errorResponse(
        env,
        method,
        404,
        "Repository not found",
        `No repository named ${repo} on this registry.`,
      );
    }
    return pageResponse(method, page);
  }

  return notFound(env, method, url);
}
