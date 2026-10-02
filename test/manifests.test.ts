import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  BASE,
  bytesOf,
  digestOf,
  errorCodeOf,
  putManifest,
  pushBlob,
  seedImage,
} from "./helpers";

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";

describe("manifest push/pull", () => {
  it("push by tag, pull by tag and by digest", async () => {
    const repo = "m/basic";
    const img = await seedImage(repo, "v1");

    const byTag = await SELF.fetch(`${BASE}/v2/${repo}/manifests/v1`);
    expect(byTag.status).toBe(200);
    expect(byTag.headers.get("Docker-Content-Digest")).toBe(img.manifestDigest);
    expect(byTag.headers.get("Content-Type")).toBe(OCI_MANIFEST);
    const body = new Uint8Array(await byTag.arrayBuffer());
    expect(await digestOf(body)).toBe(img.manifestDigest);

    const byDigest = await SELF.fetch(`${BASE}/v2/${repo}/manifests/${img.manifestDigest}`);
    expect(byDigest.status).toBe(200);

    const head = await SELF.fetch(`${BASE}/v2/${repo}/manifests/v1`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(img.manifestBytes.length));
    expect(head.headers.get("Docker-Content-Digest")).toBe(img.manifestDigest);
  });

  it("push by digest reference", async () => {
    const repo = "m/bydigest";
    const config = await pushBlob(repo, bytesOf("{}"));
    const manifest = {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: config, size: 2 },
      layers: [],
    };
    const bytes = bytesOf(JSON.stringify(manifest));
    const digest = await digestOf(bytes);
    const res = await SELF.fetch(`${BASE}/v2/${repo}/manifests/${digest}`, {
      method: "PUT",
      headers: { "Content-Type": OCI_MANIFEST },
      body: bytes as Uint8Array<ArrayBuffer>,
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Location")).toBe(`/v2/${repo}/manifests/${digest}`);
  });

  it("digest reference mismatch => 400 DIGEST_INVALID", async () => {
    const repo = "m/mismatch";
    const config = await pushBlob(repo, bytesOf("{}"));
    const manifest = {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: config, size: 2 },
      layers: [],
    };
    const wrong = await digestOf(bytesOf("other"));
    const { res } = await putManifest(repo, wrong, manifest);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe("DIGEST_INVALID");
  });

  it("manifest referencing missing blobs => MANIFEST_BLOB_UNKNOWN", async () => {
    const missing = await digestOf(bytesOf("missing blob"));
    const { res } = await putManifest("m/missing-blob", "v1", {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: missing,
        size: 10,
      },
      layers: [],
    });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe("MANIFEST_BLOB_UNKNOWN");
  });

  it("renderable Content-Type (text/html) is rejected", async () => {
    const repo = "m/xss";
    const config = await pushBlob(repo, bytesOf("{}"));
    const manifest = {
      schemaVersion: 2,
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: config, size: 2 },
      layers: [],
    };
    const { res } = await putManifest(repo, "v1", manifest, "text/html");
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe("MANIFEST_INVALID");
  });

  it("manifest GET carries X-Content-Type-Options: nosniff", async () => {
    const repo = "m/nosniff";
    await seedImage(repo, "v1");
    const res = await SELF.fetch(`${BASE}/v2/${repo}/manifests/v1`);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("accepts a manifest referencing 60 blobs (D1 bind-limit chunking)", async () => {
    const repo = "m/manylayers";
    const layers = [];
    for (let i = 0; i < 60; i++) {
      const data = bytesOf(`layer-${i}-${"x".repeat(i)}`);
      const digest = await pushBlob(repo, data);
      layers.push({
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest,
        size: data.length,
      });
    }
    const configData = bytesOf("{}");
    const configDigest = await pushBlob(repo, configData);
    const { res } = await putManifest(repo, "big", {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: configDigest,
        size: configData.length,
      },
      layers,
    });
    expect(res.status).toBe(201);
  }, 30000);

  it("non-JSON manifest => MANIFEST_INVALID", async () => {
    const res = await SELF.fetch(`${BASE}/v2/m/notjson/manifests/v1`, {
      method: "PUT",
      headers: { "Content-Type": OCI_MANIFEST },
      body: bytesOf("this is not json") as Uint8Array<ArrayBuffer>,
    });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe("MANIFEST_INVALID");
  });

  it("unknown manifest => 404 MANIFEST_UNKNOWN", async () => {
    const res = await SELF.fetch(`${BASE}/v2/m/none/manifests/latest`);
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe("MANIFEST_UNKNOWN");
  });

  it("retagging moves the tag", async () => {
    const repo = "m/retag";
    const a = await seedImage(repo, "latest");
    const configData = bytesOf(JSON.stringify({ os: "linux", v: 2 }));
    const configDigest = await pushBlob(repo, configData);
    const { digest: b, res } = await putManifest(repo, "latest", {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: configDigest,
        size: configData.length,
      },
      layers: [],
    });
    expect(res.status).toBe(201);
    expect(b).not.toBe(a.manifestDigest);
    const get = await SELF.fetch(`${BASE}/v2/${repo}/manifests/latest`);
    expect(get.headers.get("Docker-Content-Digest")).toBe(b);
  });
});

describe("image index", () => {
  it("pushes an index referencing an existing manifest", async () => {
    const repo = "idx/basic";
    const img = await seedImage(repo, "amd64");
    const index = {
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [
        {
          mediaType: OCI_MANIFEST,
          digest: img.manifestDigest,
          size: img.manifestBytes.length,
          platform: { os: "linux", architecture: "amd64" },
        },
      ],
    };
    const { res, digest } = await putManifest(repo, "multi", index, OCI_INDEX);
    expect(res.status).toBe(201);

    const get = await SELF.fetch(`${BASE}/v2/${repo}/manifests/multi`);
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Type")).toBe(OCI_INDEX);
    expect(get.headers.get("Docker-Content-Digest")).toBe(digest);
  });

  it("index referencing a missing manifest is rejected", async () => {
    const missing = await digestOf(bytesOf("ghost manifest"));
    const { res } = await putManifest(
      "idx/missing",
      "v1",
      {
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: [{ mediaType: OCI_MANIFEST, digest: missing, size: 10 }],
      },
      OCI_INDEX,
    );
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe("MANIFEST_BLOB_UNKNOWN");
  });
});

describe("manifest delete", () => {
  it("delete by tag removes the tag but keeps the manifest", async () => {
    const repo = "del/bytag";
    const img = await seedImage(repo, "v1");
    const del = await SELF.fetch(`${BASE}/v2/${repo}/manifests/v1`, { method: "DELETE" });
    expect(del.status).toBe(202);
    const byTag = await SELF.fetch(`${BASE}/v2/${repo}/manifests/v1`);
    expect(byTag.status).toBe(404);
    const byDigest = await SELF.fetch(`${BASE}/v2/${repo}/manifests/${img.manifestDigest}`);
    expect(byDigest.status).toBe(200);
  });

  it("delete by digest removes manifest and its tags", async () => {
    const repo = "del/bydigest";
    const img = await seedImage(repo, "v1");
    const del = await SELF.fetch(`${BASE}/v2/${repo}/manifests/${img.manifestDigest}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(202);
    expect((await SELF.fetch(`${BASE}/v2/${repo}/manifests/v1`)).status).toBe(404);
    expect(
      (await SELF.fetch(`${BASE}/v2/${repo}/manifests/${img.manifestDigest}`)).status,
    ).toBe(404);
  });

  it("deleting an unknown tag => 404", async () => {
    await seedImage("del/unknowntag", "v1");
    const res = await SELF.fetch(`${BASE}/v2/del/unknowntag/manifests/nope`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});

describe("tags list", () => {
  it("lists tags sorted with pagination", async () => {
    const repo = "tags/paged";
    await seedImage(repo, "a");
    const img = await seedImage(repo, "b");
    // tag the same manifest twice more via PUT by tag
    await putManifest(repo, "c", img.manifest);

    const all = await SELF.fetch(`${BASE}/v2/${repo}/tags/list`);
    expect(all.status).toBe(200);
    const body = (await all.json()) as { name: string; tags: string[] };
    expect(body.name).toBe(repo);
    expect(body.tags).toEqual(["a", "b", "c"]);

    const page1 = await SELF.fetch(`${BASE}/v2/${repo}/tags/list?n=2`);
    const p1 = (await page1.json()) as { tags: string[] };
    expect(p1.tags).toEqual(["a", "b"]);
    expect(page1.headers.get("Link")).toContain('rel="next"');

    const page2 = await SELF.fetch(`${BASE}/v2/${repo}/tags/list?n=2&last=b`);
    const p2 = (await page2.json()) as { tags: string[] };
    expect(p2.tags).toEqual(["c"]);
    expect(page2.headers.get("Link")).toBeNull();
  });

  it("unknown repo => 404 NAME_UNKNOWN", async () => {
    const res = await SELF.fetch(`${BASE}/v2/tags/ghost/tags/list`);
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe("NAME_UNKNOWN");
  });

  it("invalid n => 400", async () => {
    await seedImage("tags/badn", "v1");
    const res = await SELF.fetch(`${BASE}/v2/tags/badn/tags/list?n=banana`);
    expect(res.status).toBe(400);
  });
});

describe("catalog", () => {
  it("lists repositories", async () => {
    await seedImage("cat/one", "v1");
    await seedImage("cat/two", "v1");
    const res = await SELF.fetch(`${BASE}/v2/_catalog`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repositories: string[] };
    expect(body.repositories).toContain("cat/one");
    expect(body.repositories).toContain("cat/two");
  });
});

describe("referrers API", () => {
  it("returns referrers as an OCI index and filters by artifactType", async () => {
    const repo = "ref/basic";
    const img = await seedImage(repo, "v1");

    const emptyConfig = await pushBlob(repo, bytesOf("{}"));
    const sbom = {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      artifactType: "application/spdx+json",
      config: { mediaType: "application/vnd.oci.empty.v1+json", digest: emptyConfig, size: 2 },
      layers: [],
      subject: {
        mediaType: OCI_MANIFEST,
        digest: img.manifestDigest,
        size: img.manifestBytes.length,
      },
      annotations: { "org.example.kind": "sbom" },
    };
    const { res: sbomRes, digest: sbomDigest } = await putManifest(repo, sbomDigestTag(), sbom);
    expect(sbomRes.status).toBe(201);
    expect(sbomRes.headers.get("OCI-Subject")).toBe(img.manifestDigest);

    const res = await SELF.fetch(`${BASE}/v2/${repo}/referrers/${img.manifestDigest}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(OCI_INDEX);
    const body = (await res.json()) as {
      schemaVersion: number;
      mediaType: string;
      manifests: Array<{ digest: string; artifactType?: string }>;
    };
    expect(body.schemaVersion).toBe(2);
    expect(body.mediaType).toBe(OCI_INDEX);
    expect(body.manifests).toHaveLength(1);
    expect(body.manifests[0]!.digest).toBe(sbomDigest);
    expect(body.manifests[0]!.artifactType).toBe("application/spdx+json");

    const filtered = await SELF.fetch(
      `${BASE}/v2/${repo}/referrers/${img.manifestDigest}?artifactType=${encodeURIComponent("application/spdx+json")}`,
    );
    expect((await filtered.json() as { manifests: unknown[] }).manifests).toHaveLength(1);
    expect(filtered.headers.get("OCI-Filters-Applied")).toBe("artifactType");

    const none = await SELF.fetch(
      `${BASE}/v2/${repo}/referrers/${img.manifestDigest}?artifactType=${encodeURIComponent("application/other")}`,
    );
    expect((await none.json() as { manifests: unknown[] }).manifests).toHaveLength(0);
  });

  it("no referrers => empty index, still 200", async () => {
    const digest = await digestOf(bytesOf("lonely"));
    const res = await SELF.fetch(`${BASE}/v2/ref/empty/referrers/${digest}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { manifests: unknown[] };
    expect(body.manifests).toEqual([]);
  });
});

/** referrer manifests are usually pushed by digest; give them a tag-safe unique name */
function sbomDigestTag(): string {
  return `sbom-${crypto.randomUUID().slice(0, 8)}`;
}
