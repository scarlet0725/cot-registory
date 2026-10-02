/**
 * Dashboard page renderers. Each returns a complete HTML document; data is
 * read from D1 (metadata) and R2 (manifest JSON), and every dynamic value is
 * escaped before interpolation.
 */

import type { Env, ManifestRow } from "../types";
import { INDEX_MEDIA_TYPES, manifestKey } from "../types";
import {
  copyButton,
  escapeHtml,
  formatBytes,
  formatTime,
  manifestUrl,
  pageResponse,
  renderLayout,
  repoUrl,
  shortDigest,
} from "./html";
import type { Crumb } from "./html";

const DASH = `<span class="muted">—</span>`;
const REPO_LIST_LIMIT = 500;

function registryName(env: Env): string {
  return env.REGISTRY_NAME ?? "cot";
}

/** A shell command in a copyable box. */
function command(cmd: string): string {
  return `<div class="cmd"><code>${escapeHtml(cmd)}</code>${copyButton(cmd)}</div>`;
}

/** Short digest linking to the manifest page, full digest in the tooltip. */
function digestLink(repo: string, digest: string): string {
  return `<a class="mono" href="${escapeHtml(manifestUrl(repo, digest))}" title="${escapeHtml(digest)}">${escapeHtml(shortDigest(digest))}</a>`;
}

/** Monospace cell for a nullable string, em-dash when absent. */
function mono(value: string | null | undefined): string {
  return value ? `<span class="mono">${escapeHtml(value)}</span>` : DASH;
}

function sizeCell(size: number | null): string {
  return size === null ? DASH : escapeHtml(formatBytes(size));
}

// ---------------------------------------------------------------------------
// Error pages
// ---------------------------------------------------------------------------

export function renderErrorPage(env: Env, title: string, message: string): string {
  const content = `<div class="card empty">
<h2>${escapeHtml(title)}</h2>
<p>${escapeHtml(message)}</p>
<p><a href="/">Back to repositories</a></p>
</div>`;
  return renderLayout(registryName(env), { title, content });
}

export function errorResponse(
  env: Env,
  method: string,
  status: number,
  title: string,
  message: string,
  extraHeaders?: Record<string, string>,
): Response {
  return pageResponse(method, renderErrorPage(env, title, message), status, extraHeaders);
}

// ---------------------------------------------------------------------------
// Home: repository list
// ---------------------------------------------------------------------------

interface RepoListRow {
  name: string;
  created_at: number;
  tag_count: number;
  manifest_count: number;
  storage_size: number | null;
  last_tag_at: number | null;
  last_manifest_at: number | null;
}

export async function renderHomePage(env: Env, url: URL): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT r.name, r.created_at,
       (SELECT COUNT(*) FROM tags t WHERE t.repo = r.name) AS tag_count,
       (SELECT COUNT(*) FROM manifests m WHERE m.repo = r.name) AS manifest_count,
       (SELECT SUM(b.size) FROM repo_blobs rb JOIN blobs b ON b.digest = rb.digest
         WHERE rb.repo = r.name) AS storage_size,
       (SELECT MAX(t.updated_at) FROM tags t WHERE t.repo = r.name) AS last_tag_at,
       (SELECT MAX(m.created_at) FROM manifests m WHERE m.repo = r.name) AS last_manifest_at
     FROM repositories r
     ORDER BY r.name
     LIMIT ?`,
  )
    .bind(REPO_LIST_LIMIT)
    .all<RepoListRow>();

  let content: string;
  if (results.length === 0) {
    const host = url.host;
    content = `<h1>Repositories</h1>
<p class="subtitle">This registry is empty.</p>
<div class="card empty">
<h2>Push your first image</h2>
<p>Tag a local image with this registry&#39;s host, then push it:</p>
${command(`docker tag my-image ${host}/my-image:latest`)}
${command(`docker push ${host}/my-image:latest`)}
</div>`;
  } else {
    const rows = results
      .map((r) => {
        const last =
          Math.max(r.last_tag_at ?? 0, r.last_manifest_at ?? 0) || r.created_at;
        return `<tr>
<td><a href="${escapeHtml(repoUrl(r.name))}">${escapeHtml(r.name)}</a></td>
<td class="num">${r.tag_count}</td>
<td class="num">${r.manifest_count}</td>
<td class="num">${sizeCell(r.storage_size ?? 0)}</td>
<td class="nowrap muted">${escapeHtml(formatTime(last))}</td>
</tr>`;
      })
      .join("\n");
    const capNote =
      results.length === REPO_LIST_LIMIT
        ? `\n<p class="note">Showing the first ${REPO_LIST_LIMIT} repositories.</p>`
        : "";
    content = `<h1>Repositories</h1>
<p class="subtitle">${results.length} repositor${results.length === 1 ? "y" : "ies"}</p>
<div class="table-wrap"><table>
<thead><tr><th>Repository</th><th class="num">Tags</th><th class="num">Manifests</th><th class="num">Size</th><th>Last activity</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>${capNote}`;
  }

  return renderLayout(registryName(env), { title: "Repositories", content });
}

// ---------------------------------------------------------------------------
// Repository detail
// ---------------------------------------------------------------------------

interface RepoTagRow {
  tag: string;
  digest: string;
  updated_at: number;
  media_type: string | null;
  size: number | null;
}

interface UntaggedManifestRow {
  digest: string;
  media_type: string | null;
  artifact_type: string | null;
  size: number;
  created_at: number;
}

/** Returns null when the repository does not exist. */
export async function renderRepoPage(
  env: Env,
  url: URL,
  repo: string,
): Promise<string | null> {
  const repoRow = await env.DB.prepare(
    "SELECT name, created_at FROM repositories WHERE name = ?",
  )
    .bind(repo)
    .first<{ name: string; created_at: number }>();
  if (!repoRow) return null;

  const [tagsRes, untaggedRes] = await Promise.all([
    env.DB.prepare(
      `SELECT t.tag, t.digest, t.updated_at, m.media_type, m.size
       FROM tags t
       LEFT JOIN manifests m ON m.repo = t.repo AND m.digest = t.digest
       WHERE t.repo = ?
       ORDER BY t.tag`,
    )
      .bind(repo)
      .all<RepoTagRow>(),
    // Untagged, non-referrer manifests (referrer artifacts are listed on the
    // page of the manifest they attach to).
    env.DB.prepare(
      `SELECT digest, media_type, artifact_type, size, created_at
       FROM manifests
       WHERE repo = ? AND subject_digest IS NULL
         AND digest NOT IN (SELECT digest FROM tags WHERE repo = ?)
       ORDER BY created_at DESC`,
    )
      .bind(repo, repo)
      .all<UntaggedManifestRow>(),
  ]);
  const tags = tagsRes.results;
  const untagged = untaggedRes.results;

  let pullHint = "";
  if (tags.length > 0) {
    const chosen =
      tags.find((t) => t.tag === "latest") ??
      tags.reduce((a, b) => (b.updated_at > a.updated_at ? b : a));
    pullHint = command(`docker pull ${url.host}/${repo}:${chosen.tag}`);
  }

  const tagsTable =
    tags.length === 0
      ? `<p class="note">No tags in this repository yet.</p>`
      : `<div class="table-wrap"><table>
<thead><tr><th>Tag</th><th>Digest</th><th>Media type</th><th class="num">Size</th><th>Updated</th></tr></thead>
<tbody>
${tags
  .map(
    (t) => `<tr>
<td class="mono">${escapeHtml(t.tag)}</td>
<td>${digestLink(repo, t.digest)}</td>
<td>${mono(t.media_type)}</td>
<td class="num">${sizeCell(t.size)}</td>
<td class="nowrap muted">${escapeHtml(formatTime(t.updated_at))}</td>
</tr>`,
  )
  .join("\n")}
</tbody>
</table></div>`;

  const untaggedSection =
    untagged.length === 0
      ? ""
      : `
<h2>Untagged manifests <span class="count">(${untagged.length})</span></h2>
<div class="table-wrap"><table>
<thead><tr><th>Digest</th><th>Media type</th><th>Artifact type</th><th class="num">Size</th><th>Created</th></tr></thead>
<tbody>
${untagged
  .map(
    (m) => `<tr>
<td>${digestLink(repo, m.digest)}</td>
<td>${mono(m.media_type)}</td>
<td>${mono(m.artifact_type)}</td>
<td class="num">${sizeCell(m.size)}</td>
<td class="nowrap muted">${escapeHtml(formatTime(m.created_at))}</td>
</tr>`,
  )
  .join("\n")}
</tbody>
</table></div>`;

  const content = `<h1>${escapeHtml(repo)}</h1>
<p class="subtitle">${tags.length} tag${tags.length === 1 ? "" : "s"} · ${untagged.length} untagged · created ${escapeHtml(formatTime(repoRow.created_at))}</p>
${pullHint}
<h2>Tags <span class="count">(${tags.length})</span></h2>
${tagsTable}${untaggedSection}`;

  return renderLayout(registryName(env), {
    title: repo,
    breadcrumbs: [{ label: repo }],
    content,
  });
}

// ---------------------------------------------------------------------------
// Manifest detail
// ---------------------------------------------------------------------------

interface ReferrerRow {
  digest: string;
  media_type: string | null;
  artifact_type: string | null;
  size: number;
  created_at: number;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Narrow an unknown JSON value to an array of plain objects. */
function objectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Record<string, unknown> =>
      v !== null && typeof v === "object" && !Array.isArray(v),
  );
}

function platformLabel(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  const parts = [str(p["os"]), str(p["architecture"]), str(p["variant"])].filter(
    (part): part is string => part !== null && part.length > 0,
  );
  return parts.length > 0 ? parts.join("/") : null;
}

/** Index: table of child manifest entries. */
function renderIndexEntries(repo: string, entries: Record<string, unknown>[]): string {
  if (entries.length === 0) return "";
  const rows = entries
    .map((entry) => {
      const platform = platformLabel(entry["platform"]);
      const digest = str(entry["digest"]);
      return `<tr>
<td class="nowrap">${mono(platform)}</td>
<td>${mono(str(entry["mediaType"]))}</td>
<td class="num">${sizeCell(num(entry["size"]))}</td>
<td>${digest ? digestLink(repo, digest) : DASH}</td>
</tr>`;
    })
    .join("\n");
  return `
<h2>Manifests <span class="count">(${entries.length})</span></h2>
<div class="table-wrap"><table>
<thead><tr><th>Platform</th><th>Media type</th><th class="num">Size</th><th>Digest</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>`;
}

/** Image manifest: config row + layers table with a total. */
function renderImageManifest(body: Record<string, unknown>): string {
  let out = "";

  const config = body["config"];
  if (config !== null && typeof config === "object" && !Array.isArray(config)) {
    const c = config as Record<string, unknown>;
    const digest = str(c["digest"]);
    out += `
<h2>Config</h2>
<div class="table-wrap"><table>
<thead><tr><th>Media type</th><th class="num">Size</th><th>Digest</th></tr></thead>
<tbody>
<tr>
<td>${mono(str(c["mediaType"]))}</td>
<td class="num">${sizeCell(num(c["size"]))}</td>
<td>${digest ? `<span class="mono" title="${escapeHtml(digest)}">${escapeHtml(shortDigest(digest))}</span>` : DASH}</td>
</tr>
</tbody>
</table></div>`;
  }

  const layers = objectArray(body["layers"]);
  if (layers.length > 0) {
    const total = layers.reduce((sum, layer) => sum + (num(layer["size"]) ?? 0), 0);
    const rows = layers
      .map((layer, i) => {
        const digest = str(layer["digest"]);
        return `<tr>
<td class="num muted">${i + 1}</td>
<td>${mono(str(layer["mediaType"]))}</td>
<td class="num">${sizeCell(num(layer["size"]))}</td>
<td>${digest ? `<span class="mono" title="${escapeHtml(digest)}">${escapeHtml(shortDigest(digest))}</span>` : DASH}</td>
</tr>`;
      })
      .join("\n");
    out += `
<h2>Layers <span class="count">(${layers.length} · ${escapeHtml(formatBytes(total))} total)</span></h2>
<div class="table-wrap"><table>
<thead><tr><th class="num">#</th><th>Media type</th><th class="num">Size</th><th>Digest</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>`;
  }

  return out;
}

/** Returns null when the manifest row does not exist for this repo. */
export async function renderManifestPage(
  env: Env,
  url: URL,
  repo: string,
  digest: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT repo, digest, media_type, artifact_type, subject_digest, annotations, size, created_at
     FROM manifests WHERE repo = ? AND digest = ?`,
  )
    .bind(repo, digest)
    .first<ManifestRow>();
  if (!row) return null;

  const [object, tagsRes, referrersRes] = await Promise.all([
    env.BUCKET.get(manifestKey(digest)),
    env.DB.prepare(
      "SELECT tag FROM tags WHERE repo = ? AND digest = ? ORDER BY updated_at DESC",
    )
      .bind(repo, digest)
      .all<{ tag: string }>(),
    env.DB.prepare(
      `SELECT digest, media_type, artifact_type, size, created_at
       FROM manifests WHERE repo = ? AND subject_digest = ?
       ORDER BY created_at DESC`,
    )
      .bind(repo, digest)
      .all<ReferrerRow>(),
  ]);

  const rawText = object ? await object.text() : null;
  let body: Record<string, unknown> | null = null;
  let rawPretty: string | null = null;
  if (rawText !== null) {
    try {
      const value: unknown = JSON.parse(rawText);
      rawPretty = JSON.stringify(value, null, 2);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        body = value as Record<string, unknown>;
      }
    } catch {
      // Not JSON; the raw bytes are still shown below.
    }
  }

  const tags = tagsRes.results.map((t) => t.tag);
  const referrers = referrersRes.results;

  const isIndex =
    (row.media_type !== null && INDEX_MEDIA_TYPES.includes(row.media_type)) ||
    (body !== null && Array.isArray(body["manifests"]));

  const pullTag = tags.find((t) => t === "latest") ?? tags[0];
  const pullCmd =
    pullTag !== undefined
      ? `docker pull ${url.host}/${repo}:${pullTag}`
      : `docker pull ${url.host}/${repo}@${digest}`;

  const kv: string[] = [];
  kv.push(
    `<dt>Digest</dt><dd><span class="mono">${escapeHtml(digest)}</span> ${copyButton(digest)}</dd>`,
  );
  kv.push(`<dt>Media type</dt><dd>${mono(row.media_type)}</dd>`);
  if (row.artifact_type) {
    kv.push(`<dt>Artifact type</dt><dd>${mono(row.artifact_type)}</dd>`);
  }
  kv.push(
    `<dt>Size</dt><dd>${escapeHtml(formatBytes(row.size))} <span class="muted">(${row.size} bytes)</span></dd>`,
  );
  kv.push(`<dt>Created</dt><dd>${escapeHtml(formatTime(row.created_at))}</dd>`);
  if (tags.length > 0) {
    kv.push(`<dt>Tags</dt><dd class="mono">${tags.map((t) => escapeHtml(t)).join(", ")}</dd>`);
  }
  if (row.subject_digest) {
    kv.push(
      `<dt>Subject</dt><dd>${digestLink(repo, row.subject_digest)} <span class="muted">(this manifest is a referrer of its subject)</span></dd>`,
    );
  }

  const summary = `<div class="card">
<dl class="kv">
${kv.join("\n")}
</dl>
${command(pullCmd)}
</div>`;

  let typeSections = "";
  if (body !== null) {
    typeSections = isIndex
      ? renderIndexEntries(repo, objectArray(body["manifests"]))
      : renderImageManifest(body);
  }

  const referrersSection =
    referrers.length === 0
      ? ""
      : `
<h2>Referrers <span class="count">(${referrers.length})</span></h2>
<div class="table-wrap"><table>
<thead><tr><th>Artifact type</th><th>Media type</th><th class="num">Size</th><th>Digest</th><th>Created</th></tr></thead>
<tbody>
${referrers
  .map(
    (r) => `<tr>
<td>${mono(r.artifact_type)}</td>
<td>${mono(r.media_type)}</td>
<td class="num">${sizeCell(r.size)}</td>
<td>${digestLink(repo, r.digest)}</td>
<td class="nowrap muted">${escapeHtml(formatTime(r.created_at))}</td>
</tr>`,
  )
  .join("\n")}
</tbody>
</table></div>`;

  let annotationsSection = "";
  if (row.annotations) {
    try {
      const parsed: unknown = JSON.parse(row.annotations);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const pairs = Object.entries(parsed as Record<string, unknown>).filter(
          (pair): pair is [string, string] => typeof pair[1] === "string",
        );
        if (pairs.length > 0) {
          annotationsSection = `
<h2>Annotations <span class="count">(${pairs.length})</span></h2>
<div class="table-wrap"><table>
<thead><tr><th>Key</th><th>Value</th></tr></thead>
<tbody>
${pairs
  .map(
    ([key, value]) =>
      `<tr><td class="mono">${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`,
  )
  .join("\n")}
</tbody>
</table></div>`;
        }
      }
    } catch {
      // Malformed annotations JSON in D1 — skip the section.
    }
  }

  const rawSection =
    rawText === null
      ? `<p class="note">Manifest content is missing from storage (R2 object not found).</p>`
      : `<details><summary>Raw manifest JSON</summary><pre>${escapeHtml(rawPretty ?? rawText)}</pre></details>`;

  const subtitle = isIndex ? "Image index" : "Image manifest";
  const content = `<h1>Manifest <span class="mono">${escapeHtml(shortDigest(digest))}</span></h1>
<p class="subtitle">${subtitle} in <a href="${escapeHtml(repoUrl(repo))}">${escapeHtml(repo)}</a></p>
${summary}${typeSections}${referrersSection}${annotationsSection}
${rawSection}`;

  const breadcrumbs: Crumb[] = [
    { label: repo, href: repoUrl(repo) },
    { label: shortDigest(digest) },
  ];

  return renderLayout(registryName(env), {
    title: `${shortDigest(digest)} · ${repo}`,
    breadcrumbs,
    content,
  });
}
