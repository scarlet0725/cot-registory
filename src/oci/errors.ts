/**
 * OCI Distribution Spec error payloads.
 * https://github.com/opencontainers/distribution-spec/blob/main/spec.md#error-codes
 */

export type OCIErrorCode =
  | "BLOB_UNKNOWN"
  | "BLOB_UPLOAD_INVALID"
  | "BLOB_UPLOAD_UNKNOWN"
  | "DIGEST_INVALID"
  | "MANIFEST_BLOB_UNKNOWN"
  | "MANIFEST_INVALID"
  | "MANIFEST_UNKNOWN"
  | "NAME_INVALID"
  | "NAME_UNKNOWN"
  | "SIZE_INVALID"
  | "UNAUTHORIZED"
  | "DENIED"
  | "UNSUPPORTED"
  | "TOOMANYREQUESTS";

const DEFAULT_MESSAGES: Record<OCIErrorCode, string> = {
  BLOB_UNKNOWN: "blob unknown to registry",
  BLOB_UPLOAD_INVALID: "blob upload invalid",
  BLOB_UPLOAD_UNKNOWN: "blob upload unknown to registry",
  DIGEST_INVALID: "provided digest did not match uploaded content",
  MANIFEST_BLOB_UNKNOWN: "manifest references a blob unknown to registry",
  MANIFEST_INVALID: "manifest invalid",
  MANIFEST_UNKNOWN: "manifest unknown to registry",
  NAME_INVALID: "invalid repository name",
  NAME_UNKNOWN: "repository name not known to registry",
  SIZE_INVALID: "provided length did not match content length",
  UNAUTHORIZED: "authentication required",
  DENIED: "requested access to the resource is denied",
  UNSUPPORTED: "the operation is unsupported",
  TOOMANYREQUESTS: "too many requests",
};

/**
 * Build an OCI-spec error response:
 *   { "errors": [ { "code", "message", "detail" } ] }
 */
export function ociError(
  status: number,
  code: OCIErrorCode,
  message?: string,
  detail?: unknown,
  headers?: HeadersInit,
): Response {
  const body = {
    errors: [
      {
        code,
        message: message ?? DEFAULT_MESSAGES[code],
        ...(detail !== undefined ? { detail } : {}),
      },
    ],
  };
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: h });
}
