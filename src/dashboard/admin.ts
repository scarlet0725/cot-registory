/**
 * Admin area: access-token issuance/revocation and per-repository visibility.
 *
 * Routes (all under the env admin credentials; OPEN mode in local dev):
 *   GET  /admin                  tokens + repositories overview
 *   POST /admin/tokens           issue a token (form: label) => secret shown once
 *   POST /admin/tokens/delete    revoke a token (form: id)
 *   POST /admin/repos/visibility set a repo public/private (form: repo, visibility)
 *
 * Server-rendered HTML with plain POST forms (no JS required). POSTs reject
 * cross-origin submissions (Origin / Sec-Fetch-Site) since browsers attach
 * cached Basic credentials to cross-site form posts.
 */

import type { Env } from "../types";
import type { Principal } from "../auth";
import { BASIC_CHALLENGE, sha256Hex } from "../auth";
import { isValidRepoName } from "../oci/validation";
import {
  copyButton,
  escapeHtml,
  formatTime,
  pageResponse,
  renderLayout,
  repoUrl,
} from "./html";
import { errorResponse, visibilityBadge } from "./pages";

const MAX_LABEL_LENGTH = 100;
const REPO_LIST_LIMIT = 500;
const TOKEN_LIST_LIMIT = 500;

interface CredentialListRow {
  id: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

interface RepoVisibilityRow {
  name: string;
  visibility: string;
}

function registryName(env: Env): string {
  return env.REGISTRY_NAME ?? "cot";
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

/**
 * True when the request looks like a cross-origin form submission. `Origin`
 * must match when present; `Sec-Fetch-Site` must be same-origin (or absent —
 * non-browser clients like curl send neither header and pass).
 */
function isCrossOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== "null" && origin !== url.origin) return true;
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin" && site !== "none") return true;
  return false;
}

/** Read a trimmed string field from a form, or null. */
async function formFields(request: Request): Promise<Map<string, string> | null> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return null;
  }
  const fields = new Map<string, string>();
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") fields.set(key, value.trim());
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

async function renderAdminHome(env: Env, principal: Principal): Promise<string> {
  const [tokensRes, reposRes] = await Promise.all([
    env.DB
      .prepare(
        "SELECT id, label, created_at, last_used_at FROM credentials ORDER BY created_at DESC LIMIT ?",
      )
      .bind(TOKEN_LIST_LIMIT)
      .all<CredentialListRow>(),
    env.DB
      .prepare("SELECT name, visibility FROM repositories ORDER BY name LIMIT ?")
      .bind(REPO_LIST_LIMIT)
      .all<RepoVisibilityRow>(),
  ]);
  const tokens = tokensRes.results;
  const repos = reposRes.results;

  const openModeWarning =
    principal.kind === "open"
      ? `<div class="card"><p class="note">⚠ This registry is running in <strong>OPEN mode</strong> —
no admin credentials are configured, so everything (this page included) is unauthenticated.
Set the <code>ADMIN_USERNAME</code> and <code>ADMIN_PASSWORD</code> secrets before exposing it.</p></div>\n`
      : "";

  const tokensTable =
    tokens.length === 0
      ? `<p class="note">No access tokens yet. Issue one above — pushes and private pulls require it.</p>`
      : `<div class="table-wrap"><table>
<thead><tr><th>ID</th><th>Label</th><th>Created</th><th>Last used</th><th></th></tr></thead>
<tbody>
${tokens
  .map(
    (t) => `<tr>
<td class="mono">${escapeHtml(t.id)}</td>
<td>${escapeHtml(t.label)}</td>
<td class="nowrap muted">${escapeHtml(formatTime(t.created_at))}</td>
<td class="nowrap muted">${t.last_used_at === null ? "never" : escapeHtml(formatTime(t.last_used_at))}</td>
<td><form class="inline" method="post" action="/admin/tokens/delete">
<input type="hidden" name="id" value="${escapeHtml(t.id)}">
<button class="btn danger" type="submit">Revoke</button>
</form></td>
</tr>`,
  )
  .join("\n")}
</tbody>
</table></div>`;

  const reposTable =
    repos.length === 0
      ? `<p class="note">No repositories yet. New repositories are created on first push, as <strong>private</strong>.</p>`
      : `<div class="table-wrap"><table>
<thead><tr><th>Repository</th><th>Visibility</th><th></th></tr></thead>
<tbody>
${repos
  .map((r) => {
    const next = r.visibility === "public" ? "private" : "public";
    return `<tr>
<td><a href="${escapeHtml(repoUrl(r.name))}">${escapeHtml(r.name)}</a></td>
<td>${visibilityBadge(r.visibility)}</td>
<td><form class="inline" method="post" action="/admin/repos/visibility">
<input type="hidden" name="repo" value="${escapeHtml(r.name)}">
<input type="hidden" name="visibility" value="${next}">
<button class="btn" type="submit">Make ${next}</button>
</form></td>
</tr>`;
  })
  .join("\n")}
</tbody>
</table></div>`;

  const content = `<h1>Admin</h1>
<p class="subtitle">Access tokens and repository visibility</p>
${openModeWarning}<h2>Issue a new token</h2>
<div class="card">
<form class="row" method="post" action="/admin/tokens">
<input type="text" name="label" required maxlength="${MAX_LABEL_LENGTH}" placeholder="e.g. ci-deploy" aria-label="Token label">
<button class="btn" type="submit">Create token</button>
</form>
<p class="note">Clients sign in with the token ID as the username and the secret as the password.
The secret is shown once, on creation, and stored only as a hash.</p>
</div>

<h2>Tokens <span class="count">(${tokens.length})</span></h2>
${tokensTable}

<h2>Repositories <span class="count">(${repos.length})</span></h2>
<p class="note">Public repositories allow anonymous pulls and dashboard viewing; private ones
require a token even to pull. Pushes always require a token.</p>
${reposTable}`;

  return renderLayout(registryName(env), {
    title: "Admin",
    breadcrumbs: [{ label: "admin" }],
    content,
  });
}

function renderTokenCreated(
  env: Env,
  url: URL,
  id: string,
  label: string,
  secret: string,
): string {
  const content = `<h1>Token created</h1>
<p class="subtitle">${escapeHtml(label)}</p>
<div class="card">
<p><strong>Copy the secret now — it will not be shown again.</strong></p>
<dl class="kv">
<dt>Username (token ID)</dt><dd><span class="mono">${escapeHtml(id)}</span> ${copyButton(id)}</dd>
<dt>Secret</dt><dd><span class="mono">${escapeHtml(secret)}</span> ${copyButton(secret)}</dd>
</dl>
<p class="note">Sign in with docker:</p>
<div class="cmd"><code>${escapeHtml(`echo ${secret} | docker login ${url.host} -u ${id} --password-stdin`)}</code>${copyButton(`echo ${secret} | docker login ${url.host} -u ${id} --password-stdin`)}</div>
</div>
<p><a href="/admin">Back to admin</a></p>`;

  return renderLayout(registryName(env), {
    title: "Token created",
    breadcrumbs: [{ label: "admin", href: "/admin" }, { label: "token created" }],
    content,
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function createToken(env: Env, url: URL, request: Request): Promise<Response> {
  const fields = await formFields(request);
  const label = fields?.get("label") ?? "";
  if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
    return errorResponse(env, "POST", 400, "Invalid label", "A token label is required.");
  }

  const id = randomHex(8);
  const secret = randomHex(32);
  await env.DB
    .prepare(
      "INSERT INTO credentials (id, label, secret_hash, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(id, label, await sha256Hex(secret), Date.now())
    .run();

  return pageResponse("POST", renderTokenCreated(env, url, id, label, secret), 201);
}

async function deleteToken(env: Env, request: Request): Promise<Response> {
  const fields = await formFields(request);
  const id = fields?.get("id") ?? "";
  if (id.length === 0) {
    return errorResponse(env, "POST", 400, "Invalid request", "A token id is required.");
  }
  await env.DB.prepare("DELETE FROM credentials WHERE id = ?").bind(id).run();
  return seeOther("/admin");
}

async function setVisibility(env: Env, request: Request): Promise<Response> {
  const fields = await formFields(request);
  const repo = fields?.get("repo") ?? "";
  const visibility = fields?.get("visibility") ?? "";
  if (!isValidRepoName(repo) || (visibility !== "public" && visibility !== "private")) {
    return errorResponse(
      env,
      "POST",
      400,
      "Invalid request",
      "A repository name and a visibility of public or private are required.",
    );
  }
  await env.DB
    .prepare("UPDATE repositories SET visibility = ? WHERE name = ?")
    .bind(visibility, repo)
    .run();
  return seeOther("/admin");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
  principal: Principal,
): Promise<Response> {
  const method = request.method;

  if (principal.kind !== "admin" && principal.kind !== "open") {
    return errorResponse(
      env,
      method,
      401,
      "Admin sign-in required",
      "This area requires the registry admin credentials.",
      { "WWW-Authenticate": BASIC_CHALLENGE },
    );
  }

  const sub = url.pathname.replace(/^\/admin\/?/, "").replace(/\/+$/, "");

  if (sub === "") {
    if (method !== "GET" && method !== "HEAD") {
      return errorResponse(env, method, 405, "Method not allowed", "Use GET.", {
        Allow: "GET, HEAD",
      });
    }
    return pageResponse(method, await renderAdminHome(env, principal));
  }

  if (sub === "tokens" || sub === "tokens/delete" || sub === "repos/visibility") {
    if (method !== "POST") {
      return errorResponse(env, method, 405, "Method not allowed", "Use POST.", {
        Allow: "POST",
      });
    }
    if (isCrossOrigin(request, url)) {
      return errorResponse(
        env,
        method,
        403,
        "Cross-origin request rejected",
        "Admin actions must be submitted from this registry's own pages.",
      );
    }
    if (sub === "tokens") return createToken(env, url, request);
    if (sub === "tokens/delete") return deleteToken(env, request);
    return setVisibility(env, request);
  }

  return errorResponse(
    env,
    method,
    404,
    "Page not found",
    `The path ${url.pathname} does not exist in the admin area.`,
  );
}
