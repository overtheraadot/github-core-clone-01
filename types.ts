// types.ts — the shared request context every handler receives, and the
// result shape every handler returns. app.ts owns the socket; the handlers
// own the semantics.

export interface ReqCtx {
  method: string;
  pathname: string;
  segments: string[]; // decoded path segments, no empties
  query: URLSearchParams;
  headers: Record<string, string>; // lower-cased header names
  host: string; // request Host header (for absolute Link URLs)
  rawBody: Buffer;
  /** Parsed JSON body (only for /api/v3 routes). undefined when there is no body. */
  json: unknown;
  /** True when a body was present but did not parse as JSON. */
  jsonError: boolean;
  requestId: string;
}

export interface HandlerResult {
  status: number;
  headers?: Record<string, string>;
  /** JSON-serializable body (serialized by app.ts). */
  body?: unknown;
  /** Raw bytes (sent as-is; `body` is ignored when present). */
  raw?: Buffer;
}

export function jsonResult(status: number, body: unknown, headers?: Record<string, string>): HandlerResult {
  return { status, body, headers };
}

export function errorResult(status: number, message: string): HandlerResult {
  return { status, body: { message } };
}
