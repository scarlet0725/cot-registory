import { SELF } from "cloudflare:test";
import { expect } from "vitest";

export const BASE = "https://cot.test";

export async function sha256HexOf(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function digestOf(data: Uint8Array): Promise<string> {
  return `sha256:${await sha256HexOf(data)}`;
}

export function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // crypto.getRandomValues caps at 64 KiB per call.
  for (let i = 0; i < n; i += 65536) {
    crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, n)));
  }
  return out;
}

/** POST an upload session; returns the upload URL (Location). */
export async function startUpload(repo: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/v2/${repo}/blobs/uploads/`, { method: "POST" });
  expect(res.status).toBe(202);
  const location = res.headers.get("Location");
  expect(location).toBeTruthy();
  return new URL(location!, BASE).toString();
}

/** Classic docker flow: POST session, then single PUT with the whole body. */
export async function pushBlob(repo: string, data: Uint8Array): Promise<string> {
  const digest = await digestOf(data);
  const uploadUrl = await startUpload(repo);
  const sep = uploadUrl.includes("?") ? "&" : "?";
  const res = await SELF.fetch(`${uploadUrl}${sep}digest=${encodeURIComponent(digest)}`, {
    method: "PUT",
    body: data as Uint8Array<ArrayBuffer>,
  });
  expect(res.status).toBe(201);
  expect(res.headers.get("Docker-Content-Digest")).toBe(digest);
  return digest;
}

export interface PutManifestResult {
  digest: string;
  bytes: Uint8Array;
  res: Response;
}

export async function putManifest(
  repo: string,
  reference: string,
  manifest: unknown,
  mediaType = "application/vnd.oci.image.manifest.v1+json",
): Promise<PutManifestResult> {
  const bytes = bytesOf(JSON.stringify(manifest));
  const digest = await digestOf(bytes);
  const res = await SELF.fetch(`${BASE}/v2/${repo}/manifests/${reference}`, {
    method: "PUT",
    headers: { "Content-Type": mediaType },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  return { digest, bytes, res };
}

export interface SeededImage {
  configData: Uint8Array;
  configDigest: string;
  layerData: Uint8Array;
  layerDigest: string;
  manifest: Record<string, unknown>;
  manifestDigest: string;
  manifestBytes: Uint8Array;
}

/** Push config blob + one layer blob + an image manifest tagged `tag`. */
export async function seedImage(repo: string, tag: string): Promise<SeededImage> {
  const configData = bytesOf(JSON.stringify({ architecture: "amd64", os: "linux", config: {} }));
  const layerData = randomBytes(1024);
  const configDigest = await pushBlob(repo, configData);
  const layerDigest = await pushBlob(repo, layerData);
  const manifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: configDigest,
      size: configData.length,
    },
    layers: [
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest: layerDigest,
        size: layerData.length,
      },
    ],
  };
  const { digest, bytes, res } = await putManifest(repo, tag, manifest);
  expect(res.status).toBe(201);
  return {
    configData,
    configDigest,
    layerData,
    layerDigest,
    manifest,
    manifestDigest: digest,
    manifestBytes: bytes,
  };
}

export async function errorCodeOf(res: Response): Promise<string> {
  const body = (await res.json()) as { errors: Array<{ code: string }> };
  return body.errors[0]!.code;
}
