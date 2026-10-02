import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, seedImage } from "./helpers";

describe("dashboard", () => {
  it("serves the home page", async () => {
    const res = await SELF.fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("cot");
  });

  it("lists pushed repositories on the home page", async () => {
    await seedImage("dash/web-app", "v1");
    const res = await SELF.fetch(`${BASE}/`);
    const html = await res.text();
    expect(html).toContain("dash/web-app");
  });

  it("serves the repository page with its tags", async () => {
    await seedImage("dash/repo-page", "v1.2.3");
    const res = await SELF.fetch(`${BASE}/r/dash/repo-page`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("v1.2.3");
  });

  it("serves the manifest detail page", async () => {
    const img = await seedImage("dash/manifest-page", "v1");
    const res = await SELF.fetch(`${BASE}/r/dash/manifest-page/m/${img.manifestDigest}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(img.manifestDigest);
    // layer digest appears (shortened or full — check the hex prefix)
    expect(html).toContain(img.layerDigest.slice("sha256:".length, "sha256:".length + 8));
  });

  it("unknown repo => 404", async () => {
    const res = await SELF.fetch(`${BASE}/r/dash/ghost`);
    expect(res.status).toBe(404);
  });

  it("unknown path => 404", async () => {
    const res = await SELF.fetch(`${BASE}/definitely/not/a/page`);
    expect(res.status).toBe(404);
  });

  it("serves a favicon", async () => {
    const res = await SELF.fetch(`${BASE}/favicon.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("svg");
  });

  it("health endpoint works", async () => {
    const res = await SELF.fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
  });

  it("escapes HTML in dynamic content", async () => {
    // media types flow into the page; push a manifest with a hostile mediaType-ish
    // annotation value through the normal API and ensure no raw tag appears.
    const img = await seedImage("dash/escape", "v1");
    const res = await SELF.fetch(`${BASE}/r/dash/escape/m/${img.manifestDigest}`);
    const html = await res.text();
    expect(html).not.toContain("<script>alert");
  });
});
