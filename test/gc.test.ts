import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runGC } from "../src/gc";
import { blobKey, stagingKey } from "../src/types";
import { bytesOf, digestOf } from "./helpers";

describe("garbage collection", () => {
  it("removes stale upload sessions and their staging objects", async () => {
    const id = crypto.randomUUID();
    const key = stagingKey(id);
    await env.BUCKET.put(key, bytesOf("stale data") as Uint8Array<ArrayBuffer>);
    const old = Date.now() - 48 * 60 * 60 * 1000;
    await env.DB.prepare(
      "INSERT INTO uploads (id, repo, r2_key, bytes_received, parts, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', ?, ?)",
    )
      .bind(id, "gc/stale", key, old, old)
      .run();

    const result = await runGC(env);
    expect(result.uploadsDeleted).toBeGreaterThanOrEqual(1);

    const row = await env.DB.prepare("SELECT id FROM uploads WHERE id = ?").bind(id).first();
    expect(row).toBeNull();
    expect(await env.BUCKET.head(key)).toBeNull();
  });

  it("keeps fresh upload sessions", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO uploads (id, repo, r2_key, bytes_received, parts, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', ?, ?)",
    )
      .bind(id, "gc/fresh", stagingKey(id), now, now)
      .run();

    await runGC(env);

    const row = await env.DB.prepare("SELECT id FROM uploads WHERE id = ?").bind(id).first();
    expect(row).not.toBeNull();
  });

  it("removes orphaned blobs past the grace period, keeps linked ones", async () => {
    const orphanData = bytesOf("orphan blob");
    const linkedData = bytesOf("linked blob");
    const orphan = await digestOf(orphanData);
    const linked = await digestOf(linkedData);
    const old = Date.now() - 2 * 60 * 60 * 1000;

    await env.BUCKET.put(blobKey(orphan), orphanData as Uint8Array<ArrayBuffer>);
    await env.BUCKET.put(blobKey(linked), linkedData as Uint8Array<ArrayBuffer>);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO blobs (digest, size, created_at) VALUES (?, ?, ?)").bind(
        orphan,
        orphanData.length,
        old,
      ),
      env.DB.prepare("INSERT INTO blobs (digest, size, created_at) VALUES (?, ?, ?)").bind(
        linked,
        linkedData.length,
        old,
      ),
      env.DB.prepare("INSERT INTO repositories (name, created_at) VALUES (?, ?)").bind(
        "gc/linked",
        old,
      ),
      env.DB.prepare("INSERT INTO repo_blobs (repo, digest, created_at) VALUES (?, ?, ?)").bind(
        "gc/linked",
        linked,
        old,
      ),
    ]);

    const result = await runGC(env);
    expect(result.blobsDeleted).toBeGreaterThanOrEqual(1);

    expect(
      await env.DB.prepare("SELECT digest FROM blobs WHERE digest = ?").bind(orphan).first(),
    ).toBeNull();
    expect(await env.BUCKET.head(blobKey(orphan))).toBeNull();
    expect(
      await env.DB.prepare("SELECT digest FROM blobs WHERE digest = ?").bind(linked).first(),
    ).not.toBeNull();
    expect(await env.BUCKET.head(blobKey(linked))).not.toBeNull();
  });
});
