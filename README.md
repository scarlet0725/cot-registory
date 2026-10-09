# cot

**cot** is an OCI-conformant container registry that runs entirely on
[Cloudflare Workers](https://developers.cloudflare.com/workers/), storing
content in [R2](https://developers.cloudflare.com/r2/) and metadata in
[D1](https://developers.cloudflare.com/d1/) — with a lightweight, zero-JS-required
dashboard in the spirit of [zot](https://zotregistry.dev/).

No servers, no containers to host your containers: push with `docker push`,
pull from anywhere, browse in the dashboard.

## Features

- **OCI Distribution Spec v1.1**: pull, push (chunked + monolithic +
  cross-repo mount), content discovery (`tags/list`, `_catalog`), content
  management (delete), and the **referrers API** for artifacts
  (SBOMs, signatures, attestations) with `artifactType` filtering.
- **Content-addressed storage on R2**: blobs are deduplicated across
  repositories; cross-repo mounts are pure metadata operations.
- **Digest verification by R2 itself**: uploads stream to R2 with its native
  SHA-256 checksum enforcement — corrupt pushes never become visible.
- **Lightweight dashboard**: repository list with sizes, tag browser,
  manifest/layer inspector, referrer artifacts, multi-arch index navigation.
  Server-rendered, zero external assets, dark/light via `prefers-color-scheme`.
- **Token-based auth**: issue and revoke access tokens in the `/admin`
  dashboard (stored as SHA-256 hashes, constant-time comparison); clients use
  plain `docker login`.
- **Per-repository visibility**: each repository is **private** (token
  required even to pull) or **public** (anonymous pulls, catalog and
  dashboard visibility) — toggled in `/admin`.
- **Garbage collection** on a cron trigger: abandoned upload sessions,
  unreferenced blobs and manifests.
- **Tiny footprint** — [Hono](https://hono.dev/) is the only runtime
  dependency; everything else is platform APIs. ~16 KB gzipped.

## Architecture

```
docker / podman / oras / crane            browser
        │  /v2/* (OCI API)                  │  / (dashboard)
        ▼                                   ▼
┌─────────────────── Cloudflare Worker (cot) ───────────────────┐
│  Hono router → auth (Basic) → handlers       SSR dashboard    │
└──────┬──────────────────────────────┬─────────────────────────┘
       ▼                              ▼
   R2 bucket                       D1 database
   blobs/<digest>      content     repositories (visibility), tags,
   manifests/<digest>  (bytes)     manifests, repo_blobs, uploads,
   staging/<uuid>                  credentials (token hashes)
       ▲
       └── cron trigger: GC (stale uploads, orphaned content)
```

Uploads stage into an R2 **multipart upload** (`staging/<uuid>`, one PATCH
chunk = one part), then are copied to their content address with R2's
`sha256` option verifying the digest during the copy. Monolithic uploads
stream straight to `blobs/<digest>` with the same verification — no staging.

## Quick start

Prerequisites: a Cloudflare account with Workers, R2, and D1 enabled, and
`npm`/`node` locally.

```sh
git clone https://github.com/scarlet0725/cot-registory && cd cot-registory
npm install

# 1. Create the storage
npx wrangler r2 bucket create cot-registry
npx wrangler d1 create cot-registry
#    → paste the printed database_id into wrangler.jsonc

# 2. Apply the schema
npm run db:migrate

# 3. Admin credentials (skip both to run an OPEN registry — dev only!)
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD

# 4. Ship it
npm run deploy
```

Open `https://cot.<your-subdomain>.workers.dev/admin`, sign in with the admin
credentials, and **issue an access token** — the token ID is the username,
the secret (shown once) is the password. Then use it like any registry:

```sh
docker login cot.<your-subdomain>.workers.dev   # token ID / secret
docker tag alpine cot.<your-subdomain>.workers.dev/infra/alpine:3.20
docker push cot.<your-subdomain>.workers.dev/infra/alpine:3.20
```

Open `https://cot.<your-subdomain>.workers.dev/` for the dashboard.

## Authentication & visibility

- **Admin credentials** (`ADMIN_USERNAME`/`ADMIN_PASSWORD` secrets) guard the
  `/admin` dashboard, where access tokens are issued/revoked and repository
  visibility is toggled. They also have full registry access.
- **Access tokens** are what clients (`docker login`, CI) authenticate with.
  Secrets are stored only as SHA-256 hashes; revocation is immediate.
- **Repositories are private by default**: pulling, `tags/list`, the catalog
  entry, and the dashboard pages all require a token. Making a repository
  **public** allows anonymous pulls and dashboard viewing. Pushes always
  require a token.
- Anonymous requests for missing repositories answer `401` (not `404`), so
  private repository names never leak.
- With **both admin secrets unset** the registry runs in OPEN mode —
  everything (including `/admin`) is unauthenticated. Local dev only.

> **Note**: Docker requires HTTPS for non-localhost registries — Workers
> domains have that out of the box. A custom domain works too (add a
> [route](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
> to `wrangler.jsonc`).

## Local development

```sh
npm run db:migrate:local
npm run dev            # http://localhost:8787
npm test               # vitest + workerd (Miniflare R2/D1)
npm run lint           # biome (format + lint); `lint:fix` applies fixes
npm run check          # typecheck + lint + tests (what CI runs)
```

Push to the local instance with `docker push localhost:8787/...` (Docker
treats `localhost` as an insecure registry by default).

## Configuration

| Name | Kind | Default | Description |
| --- | --- | --- | --- |
| `ADMIN_USERNAME` | secret | *(unset)* | Admin user for `/admin` (token issuance, visibility). Unset **both** secrets ⇒ open registry (dev only). Setting only one fails closed. |
| `ADMIN_PASSWORD` | secret | *(unset)* | Admin password. |
| `REGISTRY_NAME` | var | `"cot"` | Display name in the dashboard. |

Registry clients never use the admin secrets — they authenticate with access
tokens issued at `/admin`. Per-repository visibility (public/private) lives in
D1 and is managed there too.

## Running in production

A checklist for exposing a registry to the internet:

- **Set the admin secrets.** With `ADMIN_USERNAME`/`ADMIN_PASSWORD` unset the
  registry runs wide open. Use a long random password — it is accepted via
  Basic auth on every request.
- **Rate-limit credential guessing.** The Worker logs every failed login
  (`auth: ...` lines in Workers Logs) but does not throttle by itself — IPs
  are intentionally not tracked in the Worker. Add a
  [WAF rate-limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/)
  (e.g. on responses with status 401) in front of the Worker; this requires
  running on a custom domain/zone rather than `workers.dev`.
- **Back up metadata.** Blob/manifest *content* lives in R2, but tags,
  visibility, and tokens live in D1. D1 keeps 30 days of
  [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
  history; `wrangler d1 export cot-registry --remote` takes offline snapshots.
- **Watch the logs.** `observability.enabled` is on in `wrangler.jsonc`, so
  invocations, `auth:` warnings, unhandled errors, and the nightly
  `gc: uploads=… blobs=… manifests=…` summary all land in Workers Logs.
- **Mind the plan limits.** Request-body size (layer uploads, see below), D1
  storage, and R2 class-A operations all scale with your Cloudflare plan.

## Limits & caveats

- **Layer size is capped by the Workers request-body limit** of your
  Cloudflare plan (100 MB Free, up to 500 MB on Business/Enterprise).
  Docker pushes each layer as a single PATCH, so a layer must fit in one
  request. Clients that split uploads into chunks work beyond that, with the
  rules below.
- **Chunked uploads**: R2 multipart semantics apply — every chunk except the
  final one must be the **same size** and at least **5 MiB** (the registry
  advertises `OCI-Chunk-Min-Length: 5242880`).
- Uploads without `Content-Length` (chunked transfer encoding — e.g. docker
  compressing layers on the fly) are supported: PATCH bodies are streamed into
  uniform 32 MiB multipart parts with no size limit. Monolithic single-POST /
  single-PUT uploads without `Content-Length` are buffered up to **32 MiB**
  (411 beyond that); mainstream clients send `Content-Length` on those.
- **sha256 digests only** (sha512 pushes are rejected with `UNSUPPORTED`).
- Tag listing/catalog pagination is lexical, per the spec.
- GC runs daily (cron in `wrangler.jsonc`); deletes are safe-by-grace-period.

## API support

| Spec area | Status |
| --- | --- |
| Pull (blobs, manifests, HEAD, ranges) | ✅ |
| Push (POST/PATCH/PUT, single-POST, mount) | ✅ |
| Content discovery (`tags/list`, pagination, `_catalog`) | ✅ |
| Content management (delete tags/manifests/blobs) | ✅ |
| Referrers API (+`artifactType` filter, `OCI-Subject`) | ✅ |
| Token auth (`WWW-Authenticate: Bearer`) | ❌ Basic auth only |

## License

[MIT](./LICENSE)
