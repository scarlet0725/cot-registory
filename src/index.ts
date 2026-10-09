/**
 * cot — an OCI-conformant container registry on Cloudflare Workers + R2 + D1.
 *
 * - /v2/...       OCI Distribution API
 * - /healthz      liveness probe (no auth)
 * - everything else: lightweight dashboard (SSR, no external assets)
 *
 * Routing (Hono) lives in src/router.ts; this module only exports the Worker
 * entry points.
 */

import type { Env } from "./types";
import { app } from "./router";
import { runGC } from "./gc";

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runGC(env).catch((err) => {
        // One clear log line, then rethrow so the cron run is marked failed.
        console.error("gc failed:", err instanceof Error ? (err.stack ?? err.message) : err);
        throw err;
      }),
    );
  },
} satisfies ExportedHandler<Env>;
