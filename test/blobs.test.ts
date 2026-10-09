import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  BASE,
  bytesOf,
  digestOf,
  errorCodeOf,
  pushBlob,
  randomBytes,
  startUpload,
} from "./helpers";

describe("API version check", () => {
  it("GET /v2/ returns 200 with the version header", async () => {
    const res = await SELF.fetch(`${BASE}/v2/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Docker-Distribution-API-Version")).toBe("registry/2.0");
  });

  it("GET /v2 (no trailing slash) also works", async () => {
    const res = await SELF.fetch(`${BASE}/v2`);
    expect(res.status).toBe(200);
  });
});

describe("upload session lifecycle", () => {
  it("POST creates a session with the required headers", async () => {
    const res = await SELF.fetch(`${BASE}/v2/sess/a/blobs/uploads/`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(res.headers.get("Location")).toMatch(/^\/v2\/sess\/a\/blobs\/uploads\/.+/);
    expect(res.headers.get("Docker-Upload-UUID")).toBeTruthy();
    expect(res.headers.get("Range")).toBe("0-0");
    expect(res.headers.get("OCI-Chunk-Min-Length")).toBe("5242880");
  });

  it("GET reports upload status", async () => {
    const uploadUrl = await startUpload("sess/status");
    const res = await SELF.fetch(uploadUrl);
    expect(res.status).toBe(204);
    expect(res.headers.get("Range")).toBe("0-0");
  });

  it("DELETE cancels a session; the session is gone afterwards", async () => {
    const uploadUrl = await startUpload("sess/cancel");
    const del = await SELF.fetch(uploadUrl, { method: "DELETE" });
    expect(del.status).toBe(204);
    const status = await SELF.fetch(uploadUrl);
    expect(status.status).toBe(404);
    expect(await errorCodeOf(status)).toBe("BLOB_UPLOAD_UNKNOWN");
  });

  it("unknown session id => 404 BLOB_UPLOAD_UNKNOWN", async () => {
    const res = await SELF.fetch(`${BASE}/v2/sess/x/blobs/uploads/${crypto.randomUUID()}`, {
      method: "PATCH",
      headers: { "Content-Length": "3" },
      body: bytesOf("abc") as Uint8Array<ArrayBuffer>,
    });
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe("BLOB_UPLOAD_UNKNOWN");
  });
});

describe("monolithic push (POST + PUT with body)", () => {
  it("pushes and pulls a blob intact", async () => {
    const data = randomBytes(4096);
    const digest = await pushBlob("mono/basic", data);

    const res = await SELF.fetch(`${BASE}/v2/mono/basic/blobs/${digest}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Docker-Content-Digest")).toBe(digest);
    expect(res.headers.get("Content-Length")).toBe(String(data.length));
    const body = new Uint8Array(await res.arrayBuffer());
    expect(await digestOf(body)).toBe(digest);
  });

  it("rejects digest mismatch with DIGEST_INVALID", async () => {
    const uploadUrl = await startUpload("mono/mismatch");
    const wrong = await digestOf(bytesOf("something else"));
    const res = await SELF.fetch(`${uploadUrl}?digest=${encodeURIComponent(wrong)}`, {
      method: "PUT",
      body: bytesOf("actual data") as Uint8Array<ArrayBuffer>,
    });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe("DIGEST_INVALID");
  });

  it("PUT without digest => 400 DIGEST_INVALID", async () => {
    const uploadUrl = await startUpload("mono/nodigest");
    const res = await SELF.fetch(uploadUrl, {
      method: "PUT",
      body: bytesOf("data") as Uint8Array<ArrayBuffer>,
    });
    expect(res.status).toBe(400);
  });

  it("supports the empty blob", async () => {
    const empty = new Uint8Array(0);
    const digest = await pushBlob("mono/empty", empty);
    const res = await SELF.fetch(`${BASE}/v2/mono/empty/blobs/${digest}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("0");
  });
});

describe("single-POST monolithic push", () => {
  it("POST ?digest= uploads in one request", async () => {
    const data = randomBytes(1000);
    const digest = await digestOf(data);
    const res = await SELF.fetch(
      `${BASE}/v2/onepost/img/blobs/uploads/?digest=${encodeURIComponent(digest)}`,
      { method: "POST", body: data as Uint8Array<ArrayBuffer> },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("Location")).toBe(`/v2/onepost/img/blobs/${digest}`);

    const get = await SELF.fetch(`${BASE}/v2/onepost/img/blobs/${digest}`);
    expect(get.status).toBe(200);
  });
});

describe("chunked push (PATCH)", () => {
  it("single PATCH then PUT (docker flow)", async () => {
    const data = randomBytes(2048);
    const digest = await digestOf(data);
    const uploadUrl = await startUpload("chunked/basic");

    const patch = await SELF.fetch(uploadUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/octet-stream" },
      body: data as Uint8Array<ArrayBuffer>,
    });
    expect(patch.status).toBe(202);
    expect(patch.headers.get("Range")).toBe(`0-${data.length - 1}`);

    const put = await SELF.fetch(`${uploadUrl}?digest=${encodeURIComponent(digest)}`, {
      method: "PUT",
    });
    expect(put.status).toBe(201);

    const get = await SELF.fetch(`${BASE}/v2/chunked/basic/blobs/${digest}`);
    expect(get.status).toBe(200);
    expect(await digestOf(new Uint8Array(await get.arrayBuffer()))).toBe(digest);
  });

  it("two 5MiB+ chunks then empty PUT", async () => {
    const part = 5 * 1024 * 1024;
    const data = randomBytes(part + 1234);
    const digest = await digestOf(data);
    const uploadUrl = await startUpload("chunked/multi");

    const p1 = await SELF.fetch(uploadUrl, {
      method: "PATCH",
      headers: { "Content-Range": `0-${part - 1}` },
      body: data.slice(0, part) as Uint8Array<ArrayBuffer>,
    });
    expect(p1.status).toBe(202);
    expect(p1.headers.get("Range")).toBe(`0-${part - 1}`);

    const p2 = await SELF.fetch(uploadUrl, {
      method: "PATCH",
      headers: { "Content-Range": `${part}-${data.length - 1}` },
      body: data.slice(part) as Uint8Array<ArrayBuffer>,
    });
    expect(p2.status).toBe(202);

    const put = await SELF.fetch(`${uploadUrl}?digest=${encodeURIComponent(digest)}`, {
      method: "PUT",
    });
    expect(put.status).toBe(201);

    const get = await SELF.fetch(`${BASE}/v2/chunked/multi/blobs/${digest}`);
    expect(get.status).toBe(200);
    expect(await digestOf(new Uint8Array(await get.arrayBuffer()))).toBe(digest);
  }, 30000);

  it("PATCH with wrong Content-Range offset => 416", async () => {
    const uploadUrl = await startUpload("chunked/badrange");
    const res = await SELF.fetch(uploadUrl, {
      method: "PATCH",
      headers: { "Content-Range": "100-199" },
      body: randomBytes(100) as Uint8Array<ArrayBuffer>,
    });
    expect(res.status).toBe(416);
  });

  it("second small chunk after a small first chunk is rejected", async () => {
    const uploadUrl = await startUpload("chunked/small");
    const p1 = await SELF.fetch(uploadUrl, {
      method: "PATCH",
      body: randomBytes(1024) as Uint8Array<ArrayBuffer>,
    });
    expect(p1.status).toBe(202);
    const p2 = await SELF.fetch(uploadUrl, {
      method: "PATCH",
      body: randomBytes(1024) as Uint8Array<ArrayBuffer>,
    });
    expect(p2.status).toBe(400);
  });
});

describe("blob read", () => {
  it("HEAD returns metadata without a body", async () => {
    const data = randomBytes(512);
    const digest = await pushBlob("read/head", data);
    const res = await SELF.fetch(`${BASE}/v2/read/head/blobs/${digest}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("512");
    expect(res.headers.get("Docker-Content-Digest")).toBe(digest);
  });

  it("unknown blob => 404 BLOB_UNKNOWN", async () => {
    const digest = await digestOf(bytesOf("never pushed"));
    const res = await SELF.fetch(`${BASE}/v2/read/missing/blobs/${digest}`);
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe("BLOB_UNKNOWN");
  });

  it("a blob pushed to repo A is not visible from repo B", async () => {
    const data = randomBytes(64);
    const digest = await pushBlob("scope/a", data);
    const res = await SELF.fetch(`${BASE}/v2/scope/b/blobs/${digest}`);
    expect(res.status).toBe(404);
  });

  it("supports range requests", async () => {
    const data = randomBytes(1000);
    const digest = await pushBlob("read/range", data);
    const res = await SELF.fetch(`${BASE}/v2/read/range/blobs/${digest}`, {
      headers: { Range: "bytes=100-199" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 100-199/1000");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(data.slice(100, 200));
  });

  it("malformed digest => 400 DIGEST_INVALID", async () => {
    const res = await SELF.fetch(`${BASE}/v2/read/bad/blobs/sha256:notahexstring`);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe("DIGEST_INVALID");
  });
});

describe("cross-repo mount", () => {
  it("mounts an existing blob into another repo", async () => {
    const data = randomBytes(256);
    const digest = await pushBlob("mount/src", data);
    const res = await SELF.fetch(
      `${BASE}/v2/mount/dst/blobs/uploads/?mount=${encodeURIComponent(digest)}&from=mount%2Fsrc`,
      { method: "POST" },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("Location")).toBe(`/v2/mount/dst/blobs/${digest}`);

    const get = await SELF.fetch(`${BASE}/v2/mount/dst/blobs/${digest}`);
    expect(get.status).toBe(200);
  });

  it("falls back to a session when the blob is unknown", async () => {
    const digest = await digestOf(bytesOf("missing mount"));
    const res = await SELF.fetch(
      `${BASE}/v2/mount/fallback/blobs/uploads/?mount=${encodeURIComponent(digest)}`,
      { method: "POST" },
    );
    expect(res.status).toBe(202);
    expect(res.headers.get("Location")).toBeTruthy();
  });
});

describe("blob delete", () => {
  it("deletes a blob link (202), blob then 404", async () => {
    const data = randomBytes(128);
    const digest = await pushBlob("del/one", data);
    const del = await SELF.fetch(`${BASE}/v2/del/one/blobs/${digest}`, { method: "DELETE" });
    expect(del.status).toBe(202);
    const get = await SELF.fetch(`${BASE}/v2/del/one/blobs/${digest}`);
    expect(get.status).toBe(404);
  });

  it("deleting from one repo keeps the mounted copy readable", async () => {
    const data = randomBytes(128);
    const digest = await pushBlob("del/keep-src", data);
    await SELF.fetch(`${BASE}/v2/del/keep-dst/blobs/uploads/?mount=${encodeURIComponent(digest)}`, {
      method: "POST",
    });
    await SELF.fetch(`${BASE}/v2/del/keep-src/blobs/${digest}`, { method: "DELETE" });
    const get = await SELF.fetch(`${BASE}/v2/del/keep-dst/blobs/${digest}`);
    expect(get.status).toBe(200);
  });

  it("deleting an unknown blob => 404", async () => {
    const digest = await digestOf(bytesOf("nope"));
    const res = await SELF.fetch(`${BASE}/v2/del/none/blobs/${digest}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("name validation", () => {
  it("uppercase repo names are rejected with NAME_INVALID", async () => {
    const res = await SELF.fetch(`${BASE}/v2/Bad/Name/blobs/uploads/`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe("NAME_INVALID");
  });
});
