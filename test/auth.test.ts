import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authorize } from "../src/auth";
import type { Env } from "../src/types";

function makeEnv(overrides: Partial<Env>): Env {
  return { BUCKET: env.BUCKET, DB: env.DB, ...overrides };
}

function req(auth?: string): Request {
  return new Request("https://cot.test/v2/", {
    headers: auth ? { Authorization: auth } : {},
  });
}

function basic(user: string, pass: string): string {
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

describe("authorize", () => {
  it("open mode when no credentials are configured", async () => {
    const e = makeEnv({});
    expect(await authorize(req(), e, "read")).toBeNull();
    expect(await authorize(req(), e, "write")).toBeNull();
  });

  it("fails closed when only one of username/password is set", async () => {
    const e = makeEnv({ REGISTRY_USERNAME: "admin" });
    const res = await authorize(req(basic("admin", "")), e, "read");
    expect(res?.status).toBe(401);
  });

  it("accepts valid credentials", async () => {
    const e = makeEnv({ REGISTRY_USERNAME: "admin", REGISTRY_PASSWORD: "s3cret" });
    expect(await authorize(req(basic("admin", "s3cret")), e, "write")).toBeNull();
  });

  it("accepts passwords containing colons", async () => {
    const e = makeEnv({ REGISTRY_USERNAME: "admin", REGISTRY_PASSWORD: "pa:ss:wd" });
    expect(await authorize(req(basic("admin", "pa:ss:wd")), e, "write")).toBeNull();
  });

  it("rejects bad password with a Basic challenge", async () => {
    const e = makeEnv({ REGISTRY_USERNAME: "admin", REGISTRY_PASSWORD: "s3cret" });
    const res = await authorize(req(basic("admin", "wrong")), e, "write");
    expect(res?.status).toBe(401);
    expect(res?.headers.get("WWW-Authenticate")).toContain("Basic");
    const body = (await res!.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]!.code).toBe("UNAUTHORIZED");
  });

  it("rejects bad username", async () => {
    const e = makeEnv({ REGISTRY_USERNAME: "admin", REGISTRY_PASSWORD: "s3cret" });
    const res = await authorize(req(basic("root", "s3cret")), e, "write");
    expect(res?.status).toBe(401);
  });

  it("rejects missing/malformed Authorization headers", async () => {
    const e = makeEnv({ REGISTRY_USERNAME: "admin", REGISTRY_PASSWORD: "s3cret" });
    expect((await authorize(req(), e, "read"))?.status).toBe(401);
    expect((await authorize(req("Bearer token"), e, "read"))?.status).toBe(401);
    expect((await authorize(req("Basic !!!notbase64!!!"), e, "read"))?.status).toBe(401);
  });

  it("PUBLIC_READ allows reads but not writes", async () => {
    const e = makeEnv({
      REGISTRY_USERNAME: "admin",
      REGISTRY_PASSWORD: "s3cret",
      PUBLIC_READ: "true",
    });
    expect(await authorize(req(), e, "read")).toBeNull();
    expect((await authorize(req(), e, "write"))?.status).toBe(401);
    expect(await authorize(req(basic("admin", "s3cret")), e, "write")).toBeNull();
  });
});
