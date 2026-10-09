/**
 * Tag listing + repository catalog.
 *
 * GET /v2/<name>/tags/list?n=<int>&last=<tag>
 *   - Repo must exist (`repositories`) => else 404 NAME_UNKNOWN.
 *   - Tags sorted lexically; ?n caps the page (invalid/negative n => 400),
 *     ?last resumes after that tag. Response {"name": ..., "tags": [...]}.
 *   - When truncated, add: Link: </v2/<name>/tags/list?n=N&last=X>; rel="next".
 *
 * GET /v2/_catalog?n=<int>&last=<repo>
 *   - Same pagination over repository names: {"repositories": [...]}.
 *   - Anonymous requests only see public repositories; authenticated
 *     principals (admin or issued token) see everything.
 */

import type { Env } from "../types";
import { DEFAULT_PAGE_SIZE } from "../types";
import type { Principal } from "../auth";
import { ociError } from "../oci/errors";

interface Pagination {
  limit: number;
  last: string | null;
}

/** Parse ?n / ?last, or produce the 400 UNSUPPORTED response for a bad n. */
function parsePagination(url: URL): Pagination | Response {
  const raw = url.searchParams.get("n");
  let limit = DEFAULT_PAGE_SIZE;
  if (raw !== null) {
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      return ociError(400, "UNSUPPORTED", "invalid n", { n: raw });
    }
    limit = Number(raw);
  }
  return { limit, last: url.searchParams.get("last") };
}

/**
 * Fetch one lexically ordered page of `values` (limit+1 rows to detect
 * truncation). The caller supplies ready-bound statements.
 */
async function fetchPage(
  stmt: D1PreparedStatement,
  limit: number,
  column: string,
): Promise<{ values: string[]; truncated: boolean }> {
  const rows = await stmt.all<Record<string, string>>();
  const values = rows.results.map((row) => row[column]).filter((v): v is string => v !== undefined);
  const truncated = values.length > limit;
  if (truncated) values.length = limit;
  return { values, truncated };
}

export async function handleTagsList(env: Env, repo: string, url: URL): Promise<Response> {
  const exists = await env.DB.prepare("SELECT 1 FROM repositories WHERE name = ?")
    .bind(repo)
    .first();
  if (!exists) return ociError(404, "NAME_UNKNOWN", undefined, { name: repo });

  const page = parsePagination(url);
  if (page instanceof Response) return page;

  let tags: string[] = [];
  let truncated = false;
  if (page.limit > 0) {
    const stmt =
      page.last !== null
        ? env.DB.prepare(
            "SELECT tag FROM tags WHERE repo = ? AND tag > ? ORDER BY tag LIMIT ?",
          ).bind(repo, page.last, page.limit + 1)
        : env.DB.prepare("SELECT tag FROM tags WHERE repo = ? ORDER BY tag LIMIT ?").bind(
            repo,
            page.limit + 1,
          );
    ({ values: tags, truncated } = await fetchPage(stmt, page.limit, "tag"));
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  const lastTag = tags[tags.length - 1];
  if (truncated && lastTag !== undefined) {
    headers.set(
      "Link",
      `</v2/${repo}/tags/list?n=${page.limit}&last=${encodeURIComponent(lastTag)}>; rel="next"`,
    );
  }
  return new Response(JSON.stringify({ name: repo, tags }), { status: 200, headers });
}

export async function handleCatalog(env: Env, url: URL, principal: Principal): Promise<Response> {
  const page = parsePagination(url);
  if (page instanceof Response) return page;

  let repositories: string[] = [];
  let truncated = false;
  if (page.limit > 0) {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (principal.kind === "anonymous") where.push("visibility = 'public'");
    if (page.last !== null) {
      where.push("name > ?");
      binds.push(page.last);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const stmt = env.DB.prepare(
      `SELECT name FROM repositories${clause} ORDER BY name LIMIT ?`,
    ).bind(...binds, page.limit + 1);
    ({ values: repositories, truncated } = await fetchPage(stmt, page.limit, "name"));
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  const lastName = repositories[repositories.length - 1];
  if (truncated && lastName !== undefined) {
    headers.set(
      "Link",
      `</v2/_catalog?n=${page.limit}&last=${encodeURIComponent(lastName)}>; rel="next"`,
    );
  }
  return new Response(JSON.stringify({ repositories }), { status: 200, headers });
}
