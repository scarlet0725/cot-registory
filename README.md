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
- **Basic auth** with constant-time comparison, optional public (anonymous)
  pulls via `PUBLIC_READ`.
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
   blobs/<digest>      content     repositories, tags,
   manifests/<digest>  (bytes)     manifests, repo_blobs,
   staging/<uuid>                  uploads   (metadata)
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
git clone https://github.com/scarlet0725/cot && cd cot
npm install

# 1. Create the storage
npx wrangler r2 bucket create cot-registry
npx wrangler d1 create cot-registry
#    → paste the printed database_id into wrangler.jsonc

# 2. Apply the schema
npm run db:migrate

# 3. Credentials (skip both to run an OPEN registry — dev only!)
npx wrangler secret put REGISTRY_USERNAME
npx wrangler secret put REGISTRY_PASSWORD

# 4. Ship it
npm run deploy
```

Then use it like any registry:

```sh
docker login cot.<your-subdomain>.workers.dev
docker tag alpine cot.<your-subdomain>.workers.dev/infra/alpine:3.20
docker push cot.<your-subdomain>.workers.dev/infra/alpine:3.20
```

Open `https://cot.<your-subdomain>.workers.dev/` for the dashboard.

> **Note**: Docker requires HTTPS for non-localhost registries — Workers
> domains have that out of the box. A custom domain works too (add a
> [route](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
> to `wrangler.jsonc`).

## Local development

```sh
npm run db:migrate:local
npm run dev            # http://localhost:8787
npm test               # vitest + workerd (Miniflare R2/D1)
```

Push to the local instance with `docker push localhost:8787/...` (Docker
treats `localhost` as an insecure registry by default).

## Configuration

| Name | Kind | Default | Description |
| --- | --- | --- | --- |
| `REGISTRY_USERNAME` | secret | *(unset)* | Basic auth user. Unset **both** secrets ⇒ open registry (dev only). Setting only one fails closed. |
| `REGISTRY_PASSWORD` | secret | *(unset)* | Basic auth password. |
| `PUBLIC_READ` | var | `"false"` | `"true"` ⇒ anonymous pulls (GET/HEAD) and public dashboard; pushes still need auth. |
| `REGISTRY_NAME` | var | `"cot"` | Display name in the dashboard. |

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
