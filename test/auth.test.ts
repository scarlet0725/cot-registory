import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authenticate, authorizeRepo, sha256Hex } from "../src/auth";
import type { Principal } from "../src/auth";
import type { Env } from "../src/types";

function makeEnv(overrides: Partial<Env>): Env {
  return { BUCKET: env.BUCKET, DB: env.DB, ...overrides };
}

const ADMIN_ENV = makeEnv({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "s3cret" });

function req(auth?: string): Request {
  return new Request("https://cot.test/v2/", {
    headers: auth ? { Authorization: auth } : {},
  });
}

function basic(user: string, pass: string): string {
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

let seq = 0;
/** Insert a token row; returns its id and secret. */
async function issueToken(): Promise<{ id: string; secret: string }> {
  const id = `tok${Date.now().toString(36)}${seq++}`;
  const secret = `secret-${id}`;
  await env.DB.prepare(
    "INSERT INTO credentials (id, label, secret_hash, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, `test ${id}`, await sha256Hex(secret), Date.now())
    .run();
  return { id, secret };
}

async function createRepo(visibility: "public" | "private"): Promise<string> {
  const name = `authz/${visibility}-${Date.now().toString(36)}${seq++}`;
  await env.DB.prepare("INSERT INTO repositories (name, created_at, visibility) VALUES (?, ?, ?)")
    .bind(name, Date.now(), visibility)
    .run();
  return name;
}

function kindOf(result: Principal | Response): string {
  return result instanceof Response ? `response:${result.status}` : result.kind;
}

describe("authenticate", () => {
  it("open mode when no admin credentials are configured", async () => {
    expect(kindOf(await authenticate(req(), makeEnv({})))).toBe("open");
    expect(kindOf(await authenticate(req(basic("x", "y")), makeEnv({})))).toBe("open");
  });

  it("fails closed when only one of username/password is set", async () => {
    const e = makeEnv({ ADMIN_USERNAME: "admin" });
    expect(kindOf(await authenticate(req(), e))).toBe("response:401");
  });

  it("no Authorization header => anonymous", async () => {
    expect(kindOf(await authenticate(req(), ADMIN_ENV))).toBe("anonymous");
  });

  it("accepts the admin credentials", async () => {
    expect(kindOf(await authenticate(req(basic("admin", "s3cret")), ADMIN_ENV))).toBe("admin");
  });

  it("accepts admin passwords containing colons", async () => {
    const e = makeEnv({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "pa:ss:wd" });
    expect(kindOf(await authenticate(req(basic("admin", "pa:ss:wd")), e))).toBe("admin");
  });

  it("rejects a bad admin password with a Basic challenge", async () => {
    const res = await authenticate(req(basic("admin", "wrong")), ADMIN_ENV);
    expect(res).toBeInstanceOf(Response);
    const denied = res as Response;
    expect(denied.status).toBe(401);
    expect(denied.headers.get("WWW-Authenticate")).toContain("Basic");
    const body = (await denied.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]!.code).toBe("UNAUTHORIZED");
  });

  it("accepts an issued token and records last_used_at", async () => {
    const { id, secret } = await issueToken();
    const result = await authenticate(req(basic(id, secret)), ADMIN_ENV);
    expect(result).toEqual({ kind: "credential", id });

    const row = await env.DB.prepare("SELECT last_used_at FROM credentials WHERE id = ?")
      .bind(id)
      .first<{ last_used_at: number | null }>();
    expect(row?.last_used_at).toBeTypeOf("number");
  });

  it("rejects a wrong token secret and unknown token ids", async () => {
    const { id } = await issueToken();
    expect(kindOf(await authenticate(req(basic(id, "wrong")), ADMIN_ENV))).toBe("response:401");
    expect(kindOf(await authenticate(req(basic("no-such-id", "x")), ADMIN_ENV))).toBe(
      "response:401",
    );
  });

  it("rejects a revoked token", async () => {
    const { id, secret } = await issueToken();
    await env.DB.prepare("DELETE FROM credentials WHERE id = ?").bind(id).run();
    expect(kindOf(await authenticate(req(basic(id, secret)), ADMIN_ENV))).toBe("response:401");
  });

  it("rejects malformed Authorization headers", async () => {
    expect(kindOf(await authenticate(req("Bearer token"), ADMIN_ENV))).toBe("response:401");
    expect(kindOf(await authenticate(req("Basic !!!notbase64!!!"), ADMIN_ENV))).toBe(
      "response:401",
    );
    expect(kindOf(await authenticate(req(`Basic ${btoa("nocolon")}`), ADMIN_ENV))).toBe(
      "response:401",
    );
  });
});

describe("authorizeRepo", () => {
  const anonymous: Principal = { kind: "anonymous" };
  const credential: Principal = { kind: "credential", id: "any" };

  it("authenticated principals have full access", async () => {
    const repo = await createRepo("private");
    expect(await authorizeRepo({ kind: "open" }, ADMIN_ENV, repo, "write")).toBeNull();
    expect(await authorizeRepo({ kind: "admin" }, ADMIN_ENV, repo, "write")).toBeNull();
    expect(await authorizeRepo(credential, ADMIN_ENV, repo, "read")).toBeNull();
    expect(await authorizeRepo(credential, ADMIN_ENV, repo, "write")).toBeNull();
  });

  it("anonymous may read public repos only", async () => {
    const pub = await createRepo("public");
    const priv = await createRepo("private");
    expect(await authorizeRepo(anonymous, ADMIN_ENV, pub, "read")).toBeNull();
    expect((await authorizeRepo(anonymous, ADMIN_ENV, priv, "read"))?.status).toBe(401);
  });

  it("anonymous never writes, even to public repos", async () => {
    const pub = await createRepo("public");
    expect((await authorizeRepo(anonymous, ADMIN_ENV, pub, "write"))?.status).toBe(401);
  });

  it("missing repos read as private (existence does not leak)", async () => {
    const res = await authorizeRepo(anonymous, ADMIN_ENV, "authz/no-such-repo", "read");
    expect(res?.status).toBe(401);
  });
});
