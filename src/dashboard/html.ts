/**
 * HTML building blocks for the dashboard: escaping, layout shell, response
 * helper, and small formatters (bytes, timestamps, digests, URLs).
 *
 * Every renderer in this module escapes the dynamic values it receives; page
 * code must still call escapeHtml on anything it interpolates directly.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/** Human-readable byte size, e.g. "12.4 MiB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rendered =
    unit === 0 ? String(value) : value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${rendered} ${BYTE_UNITS[unit]!}`;
}

/** Millisecond timestamp as UTC ISO 8601 (second precision). */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** First 12 characters of the encoded part of a digest ("sha256:abc..." -> "abc..."). */
export function shortDigest(digest: string): string {
  const idx = digest.indexOf(":");
  const encoded = idx >= 0 ? digest.slice(idx + 1) : digest;
  return encoded.slice(0, 12);
}

/** Dashboard URL of a repository page (name may contain "/"). */
export function repoUrl(repo: string): string {
  return "/r/" + repo.split("/").map(encodeURIComponent).join("/");
}

/** Dashboard URL of a manifest page. */
export function manifestUrl(repo: string, digest: string): string {
  return `${repoUrl(repo)}/m/${encodeURIComponent(digest)}`;
}

/** Clipboard button; a no-JS page simply renders it inert. */
export function copyButton(text: string): string {
  return `<button class="copy" type="button" data-copy="${escapeHtml(text)}" title="Copy to clipboard">copy</button>`;
}

export interface Crumb {
  label: string;
  /** Omit on the final (current page) crumb. */
  href?: string;
}

export interface Page {
  /** Document title; the registry name is appended automatically. */
  title: string;
  /** Breadcrumb trail; the leading registry-name crumb is implicit. */
  breadcrumbs?: Crumb[];
  /** Pre-rendered, already-escaped body HTML. */
  content: string;
}

const STYLE = `
* { box-sizing: border-box; }
:root {
  color-scheme: light dark;
  --bg: #f4f6f8;
  --surface: #ffffff;
  --text: #1b2430;
  --muted: #5f6b7a;
  --border: #d8dee6;
  --hairline: #e7ebf0;
  --accent: #0b63ce;
  --code-bg: #eef1f5;
  --danger: #b42318;
  --ok: #1a7f37;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --text: #e6edf3;
    --muted: #8d96a0;
    --border: #30363d;
    --hairline: #242b33;
    --accent: #4493f8;
    --code-bg: #1d232b;
    --danger: #f85149;
    --ok: #3fb950;
  }
}
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
.mono { font-size: 12.5px; }
.muted { color: var(--muted); }

.topbar { background: var(--surface); border-bottom: 1px solid var(--border); }
.topbar-inner {
  max-width: 1100px; margin: 0 auto; padding: 10px 20px;
  display: flex; align-items: center; gap: 10px;
}
.brand { font-size: 16px; font-weight: 650; color: var(--text); letter-spacing: .01em; }
.brand:hover { text-decoration: none; }
.badge {
  padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px;
  font-size: 11px; color: var(--muted); white-space: nowrap;
}

main { max-width: 1100px; margin: 0 auto; padding: 20px 20px 40px; }
.crumbs { margin: 2px 0 18px; font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
.crumbs .sep { margin: 0 6px; color: var(--muted); }
h1 { font-size: 20px; font-weight: 650; margin: 0 0 2px; overflow-wrap: anywhere; }
.subtitle { color: var(--muted); margin: 0 0 16px; font-size: 13px; }
h2 { font-size: 14px; font-weight: 650; margin: 26px 0 8px; }
h2 .count { color: var(--muted); font-weight: 400; }

.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 14px 16px; margin: 0 0 18px;
}
.table-wrap {
  overflow-x: auto; background: var(--surface);
  border: 1px solid var(--border); border-radius: 8px;
}
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th {
  text-align: left; font-size: 11px; font-weight: 600; letter-spacing: .05em;
  text-transform: uppercase; color: var(--muted);
  padding: 8px 12px; border-bottom: 1px solid var(--border); white-space: nowrap;
}
td { padding: 7px 12px; border-top: 1px solid var(--hairline); vertical-align: top; }
tbody tr:first-child td { border-top: none; }
th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.nowrap { white-space: nowrap; }

.kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px; margin: 0; }
.kv dt { color: var(--muted); font-size: 13px; }
.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }

.cmd {
  display: flex; align-items: center; gap: 8px; max-width: 720px;
  background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px;
  padding: 6px 10px; margin: 6px 0;
}
.cmd code { flex: 1 1 auto; font-size: 12.5px; white-space: nowrap; overflow-x: auto; }
button.copy {
  flex: 0 0 auto; font: 11px/1 system-ui, sans-serif; color: var(--muted);
  background: var(--surface); border: 1px solid var(--border); border-radius: 5px;
  padding: 4px 8px; cursor: pointer;
}
button.copy:hover { color: var(--text); border-color: var(--muted); }

.empty { padding: 22px 24px; }
.empty h2 { margin: 0 0 6px; }
.empty p { color: var(--muted); margin: 0 0 12px; }
.note { color: var(--muted); font-size: 13px; }

.topbar-inner .spacer { flex: 1 1 auto; }
.topbar-inner .nav { color: var(--muted); font-size: 13px; }
.topbar-inner .nav:hover { color: var(--text); text-decoration: none; }

form.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0; }
form.inline { display: inline; margin: 0; }
input[type="text"] {
  font: inherit; font-size: 13.5px; color: var(--text); background: var(--bg);
  border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; min-width: 220px;
}
input[type="text"]:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.btn {
  font: 13px/1.2 system-ui, sans-serif; color: var(--text);
  background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
  padding: 6px 12px; cursor: pointer;
}
.btn:hover { border-color: var(--muted); }
.btn.danger { color: var(--danger); }
.btn.danger:hover { border-color: var(--danger); }

.vis {
  padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px;
  font-size: 11px; white-space: nowrap;
}
.vis.public { color: var(--ok); border-color: var(--ok); }
.vis.private { color: var(--muted); }

details { margin: 22px 0 0; }
details summary { cursor: pointer; font-weight: 600; font-size: 14px; }
details pre {
  margin: 10px 0 0; padding: 12px 14px; font-size: 12px; line-height: 1.45;
  background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px;
  overflow-x: auto;
}

footer {
  max-width: 1100px; margin: 0 auto; padding: 0 20px 24px;
  color: var(--muted); font-size: 12px;
}
`;

/**
 * Copy-to-clipboard enhancement. Static script only — no dynamic values are
 * ever interpolated into it (values travel via escaped data-copy attributes).
 */
const COPY_SCRIPT = `<script>
document.addEventListener("click", function (e) {
  var t = e.target;
  var el = t && t.closest ? t.closest("button[data-copy]") : null;
  if (!el || !navigator.clipboard) return;
  navigator.clipboard.writeText(el.getAttribute("data-copy") || "").then(function () {
    el.textContent = "copied";
    setTimeout(function () { el.textContent = "copy"; }, 1200);
  });
});
</script>`;

/** Render a full HTML document around the page content. */
export function renderLayout(registryName: string, page: Page): string {
  const name = escapeHtml(registryName);
  let crumbs = "";
  if (page.breadcrumbs && page.breadcrumbs.length > 0) {
    const parts = [`<a href="/">${name}</a>`];
    for (const crumb of page.breadcrumbs) {
      parts.push(
        crumb.href !== undefined
          ? `<a href="${escapeHtml(crumb.href)}">${escapeHtml(crumb.label)}</a>`
          : `<span>${escapeHtml(crumb.label)}</span>`,
      );
    }
    crumbs = `<nav class="crumbs">${parts.join(`<span class="sep">/</span>`)}</nav>\n`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(page.title)} · ${name}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>${STYLE}</style>
</head>
<body>
<header class="topbar"><div class="topbar-inner">
<a class="brand" href="/">${name}</a>
<span class="badge">OCI registry</span>
<span class="spacer"></span>
<a class="nav" href="/admin">admin</a>
</div></header>
<main>
${crumbs}${page.content}
</main>
<footer>${name} · OCI container registry on Cloudflare Workers</footer>
${COPY_SCRIPT}
</body>
</html>`;
}

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "img-src 'self' data:",
  "base-uri 'none'",
  // The admin pages submit POST forms to this origin.
  "form-action 'self'",
].join("; ");

/** Wrap a rendered document in a Response; HEAD requests get no body. */
export function pageResponse(
  method: string,
  html: string,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": CSP,
  });
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  }
  return new Response(method === "HEAD" ? null : html, { status, headers });
}
