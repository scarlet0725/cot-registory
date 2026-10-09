/**
 * End-to-end tests for the admin area and per-repository visibility, run
 * against the Hono app with admin credentials configured (SELF runs the
 * worker in OPEN mode, which is used only for seeding content).
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../src/router";
import type { Env } from "../src/types";
import { BASE, seedImage } from "./helpers";

const ADMIN = { user: "root", pass: "hunter2" };
const AUTH_ENV = {
  ...env,
  ADMIN_USERNAME: ADMIN.user,
  ADMIN_PASSWORD: ADMIN.pass,
} as unknown as Env;

function basic(user: string, pass: string): string {
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

/** Fetch against the app with admin credentials configured. */
function fetchAuthed(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`, init), AUTH_ENV));
}

function adminForm(
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetchAuthed(path, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { Authorization: basic(ADMIN.user, ADMIN.pass), ...headers },
  });
}

/** Issue a token through the admin UI; parse id/secret out of the page. */
async function issueToken(label: string): Promise<{ id: string; secret: string }> {
  const res = await adminForm("/admin/tokens", { label });
  expect(res.status).toBe(201);
  const html = await res.text();
  const id = /data-copy="([0-9a-f]{16})"/.exec(html)?.[1];
  const secret = /data-copy="([0-9a-f]{64})"/.exec(html)?.[1];
  expect(id).toBeTruthy();
  expect(secret).toBeTruthy();
  return { id: id!, secret: secret! };
}

let seq = 0;
function uniqueRepo(prefix: string): string {
  return `${prefix}/${Date.now().toString(36)}-${seq++}`;
}

describe("admin area", () => {
  it("requires the admin credentials", async () => {
    const anonymous = await fetchAuthed("/admin");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("WWW-Authenticate")).toContain("Basic");

    const { id, secret } = await issueToken("not-an-admin");
    const tokenRes = await fetchAuthed("/admin", {
      headers: { Authorization: basic(id, secret) },
    });
    expect(tokenRes.status).toBe(401);

    const adminRes = await fetchAuthed("/admin", {
      headers: { Authorization: basic(ADMIN.user, ADMIN.pass) },
    });
    expect(adminRes.status).toBe(200);
    expect(await adminRes.text()).toContain("Issue a new token");
  });

  it("issued tokens pass the /v2 ping; anonymous gets the challenge", async () => {
    const { id, secret } = await issueToken("ping");
    const anonymous = await fetchAuthed("/v2/");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("WWW-Authenticate")).toContain("Basic");
    // Clients sniff this header to confirm a v2 registry, including on the 401.
    expect(anonymous.headers.get("Docker-Distribution-API-Version")).toBe("registry/2.0");

    const authed = await fetchAuthed("/v2/", {
      headers: { Authorization: basic(id, secret) },
    });
    expect(authed.status).toBe(200);
    expect(authed.headers.get("Docker-Distribution-API-Version")).toBe("registry/2.0");
  });

  it("pushes require a token", async () => {
    const repo = uniqueRepo("admin/push");
    const anonymous = await fetchAuthed(`/v2/${repo}/blobs/uploads/`, { method: "POST" });
    expect(anonymous.status).toBe(401);

    const { id, secret } = await issueToken("pusher");
    const authed = await fetchAuthed(`/v2/${repo}/blobs/uploads/`, {
      method: "POST",
      headers: { Authorization: basic(id, secret) },
    });
    expect(authed.status).toBe(202);
  });

  it("revoked tokens stop authenticating", async () => {
    const { id, secret } = await issueToken("short-lived");
    const del = await adminForm("/admin/tokens/delete", { id });
    expect(del.status).toBe(303);

    const res = await fetchAuthed("/v2/", {
      headers: { Authorization: basic(id, secret) },
    });
    expect(res.status).toBe(401);
  });

  it("rejects cross-origin admin form posts", async () => {
    const res = await adminForm(
      "/admin/tokens",
      { label: "csrf" },
      { Origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);

    // An opaque origin (sandboxed iframe, data: URL) is cross-origin too.
    const nullOrigin = await adminForm("/admin/tokens", { label: "csrf" }, { Origin: "null" });
    expect(nullOrigin.status).toBe(403);

    const crossSite = await adminForm(
      "/admin/tokens",
      { label: "csrf" },
      { "Sec-Fetch-Site": "cross-site" },
    );
    expect(crossSite.status).toBe(403);
  });
});

describe("per-repository visibility", () => {
  it("private repos deny anonymous pulls; flipping to public allows them", async () => {
    const repo = uniqueRepo("vis/flip");
    const img = await seedImage(repo, "v1"); // seeded via SELF (OPEN mode)

    // Default visibility is private: anonymous pull is challenged, token works.
    const deniedManifest = await fetchAuthed(`/v2/${repo}/manifests/v1`);
    expect(deniedManifest.status).toBe(401);
    const deniedBlob = await fetchAuthed(`/v2/${repo}/blobs/${img.layerDigest}`);
    expect(deniedBlob.status).toBe(401);
    const deniedTags = await fetchAuthed(`/v2/${repo}/tags/list`);
    expect(deniedTags.status).toBe(401);

    const { id, secret } = await issueToken("puller");
    const authedManifest = await fetchAuthed(`/v2/${repo}/manifests/v1`, {
      headers: { Authorization: basic(id, secret) },
    });
    expect(authedManifest.status).toBe(200);

    // Flip to public via the admin form.
    const flip = await adminForm("/admin/repos/visibility", {
      repo,
      visibility: "public",
    });
    expect(flip.status).toBe(303);

    expect((await fetchAuthed(`/v2/${repo}/manifests/v1`)).status).toBe(200);
    expect((await fetchAuthed(`/v2/${repo}/blobs/${img.layerDigest}`)).status).toBe(200);
    expect((await fetchAuthed(`/v2/${repo}/tags/list`)).status).toBe(200);
  });

  it("anonymous pulls of missing repos get 401, not 404", async () => {
    const res = await fetchAuthed(`/v2/vis/no-such-repo/manifests/latest`);
    expect(res.status).toBe(401);
  });

  it("the catalog hides private repos from anonymous clients", async () => {
    const pub = uniqueRepo("vis/cat-pub");
    const priv = uniqueRepo("vis/cat-priv");
    await seedImage(pub, "v1");
    await seedImage(priv, "v1");
    await adminForm("/admin/repos/visibility", { repo: pub, visibility: "public" });

    const anonymous = await fetchAuthed("/v2/_catalog?n=1000");
    expect(anonymous.status).toBe(200);
    const anonList = ((await anonymous.json()) as { repositories: string[] }).repositories;
    expect(anonList).toContain(pub);
    expect(anonList).not.toContain(priv);

    const { id, secret } = await issueToken("cataloger");
    const authed = await fetchAuthed("/v2/_catalog?n=1000", {
      headers: { Authorization: basic(id, secret) },
    });
    const authedList = ((await authed.json()) as { repositories: string[] }).repositories;
    expect(authedList).toContain(pub);
    expect(authedList).toContain(priv);
  });

  it("the dashboard hides private repos from anonymous viewers", async () => {
    const pub = uniqueRepo("vis/dash-pub");
    const priv = uniqueRepo("vis/dash-priv");
    await seedImage(pub, "v1");
    await seedImage(priv, "v1");
    await adminForm("/admin/repos/visibility", { repo: pub, visibility: "public" });

    const home = await fetchAuthed("/");
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain(pub);
    expect(html).not.toContain(priv);

    const privPage = await fetchAuthed(`/r/${priv}`);
    expect(privPage.status).toBe(401);
    expect(privPage.headers.get("WWW-Authenticate")).toContain("Basic");

    const pubPage = await fetchAuthed(`/r/${pub}`);
    expect(pubPage.status).toBe(200);
  });
});
