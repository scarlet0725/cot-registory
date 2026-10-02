import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, digestOf, randomBytes, startUpload } from "./helpers";

/**
 * Clients using chunked transfer encoding send no Content-Length; the
 * registry buffers such bodies (up to a cap) because R2 needs known lengths.
 */
function streamOf(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data.slice(0, Math.floor(data.length / 2)));
      controller.enqueue(data.slice(Math.floor(data.length / 2)));
      controller.close();
    },
  });
}

describe("streaming bodies without Content-Length (chunked TE)", () => {
  it("PATCH accepts a stream body", async () => {
    const data = randomBytes(2048);
    const digest = await digestOf(data);
    const uploadUrl = await startUpload("stream/patch");
    const patch = await SELF.fetch(uploadUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/octet-stream" },
      body: streamOf(data),
      // @ts-expect-error duplex is required for stream bodies
      duplex: "half",
    });
    expect(patch.status).toBe(202);
    expect(patch.headers.get("Range")).toBe(`0-${data.length - 1}`);

    const put = await SELF.fetch(`${uploadUrl}?digest=${encodeURIComponent(digest)}`, {
      method: "PUT",
    });
    expect(put.status).toBe(201);

    const get = await SELF.fetch(`${BASE}/v2/stream/patch/blobs/${digest}`);
    expect(await digestOf(new Uint8Array(await get.arrayBuffer()))).toBe(digest);
  });

  it("PATCH splits a stream larger than one part into uniform multipart parts", async () => {
    // 33 MiB > STREAM_PART_SIZE (32 MiB) => two parts (32 MiB + 1 MiB).
    const data = randomBytes(33 * 1024 * 1024);
    const digest = await digestOf(data);
    const uploadUrl = await startUpload("stream/multipart");
    const patch = await SELF.fetch(uploadUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/octet-stream" },
      body: streamOf(data),
      // @ts-expect-error duplex is required for stream bodies
      duplex: "half",
    });
    expect(patch.status).toBe(202);
    expect(patch.headers.get("Range")).toBe(`0-${data.length - 1}`);

    const put = await SELF.fetch(`${uploadUrl}?digest=${encodeURIComponent(digest)}`, {
      method: "PUT",
    });
    expect(put.status).toBe(201);

    const get = await SELF.fetch(`${BASE}/v2/stream/multipart/blobs/${digest}`);
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Length")).toBe(String(data.length));
    expect(await digestOf(new Uint8Array(await get.arrayBuffer()))).toBe(digest);
  }, 60000);

  it("single-POST monolithic accepts a stream body", async () => {
    const data = randomBytes(1000);
    const digest = await digestOf(data);
    const res = await SELF.fetch(
      `${BASE}/v2/stream/onepost/blobs/uploads/?digest=${encodeURIComponent(digest)}`,
      {
        method: "POST",
        body: streamOf(data),
        // @ts-expect-error duplex is required for stream bodies
        duplex: "half",
      },
    );
    expect(res.status).toBe(201);
  });

  it("PUT completion accepts a stream body", async () => {
    const data = randomBytes(1000);
    const digest = await digestOf(data);
    const uploadUrl = await startUpload("stream/put");
    const res = await SELF.fetch(`${uploadUrl}?digest=${encodeURIComponent(digest)}`, {
      method: "PUT",
      body: streamOf(data),
      // @ts-expect-error duplex is required for stream bodies
      duplex: "half",
    });
    expect(res.status).toBe(201);

    const get = await SELF.fetch(`${BASE}/v2/stream/put/blobs/${digest}`);
    expect(await digestOf(new Uint8Array(await get.arrayBuffer()))).toBe(digest);
  });
});
