import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebError } from "./protocol.js";

export const securityHeaders = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "cross-origin-resource-policy": "same-origin",
};

export function checkRequest(req: IncomingMessage, port: number, api: boolean): void {
  const authority = `127.0.0.1:${port}`;
  let hostCount = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === "host") hostCount++;
  if (hostCount !== 1 || req.headers.host !== authority || !req.url?.startsWith("/") || req.url.startsWith("//")) {
    throw new WebError(403, "invalid_host");
  }
  const origin = `http://${authority}`;
  if (req.headers.origin !== undefined && req.headers.origin !== origin) throw new WebError(403, "invalid_origin");
  if (req.headers["sec-fetch-site"] === "cross-site" || req.headers["sec-fetch-site"] === "same-site") {
    throw new WebError(403, "cross_origin_request");
  }
  if (api && (req.headers["x-tomo-request"] !== "1" || req.headers["sec-fetch-site"] !== "same-origin")) {
    throw new WebError(403, "same_origin_required");
  }
  if (api && req.method !== "GET" && req.headers.origin !== origin) throw new WebError(403, "origin_required");
}

/** Browser capabilities are process-local, bounded, and never logged. */
export class CsrfTokens {
  private tokens = new Map<string, { token: string; expires: number }>();
  constructor(private readonly now = Date.now) {}

  bootstrap(req: IncomingMessage, res: ServerResponse): string {
    const now = this.now();
    for (const [id, value] of this.tokens) if (value.expires < now) this.tokens.delete(id);
    const existing = this.cookie(req);
    const found = existing && this.tokens.get(existing);
    if (found) return found.token;
    if (this.tokens.size >= 64) throw new WebError(429, "browser_limit");
    const id = randomBytes(32).toString("base64url");
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(id, { token, expires: now + 12 * 60 * 60_000 });
    res.setHeader("set-cookie", `tomo_web=${id}; HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=43200`);
    return token;
  }

  verify(req: IncomingMessage): void {
    const id = this.cookie(req);
    const saved = id && this.tokens.get(id);
    const actual = req.headers["x-tomo-csrf"];
    if (!saved || saved.expires < this.now() || typeof actual !== "string" || Buffer.byteLength(actual) !== Buffer.byteLength(saved.token)
      || !timingSafeEqual(Buffer.from(actual), Buffer.from(saved.token))) throw new WebError(403, "invalid_csrf");
    if (req.headers["content-type"] !== "application/json") throw new WebError(415, "json_required");
  }

  private cookie(req: IncomingMessage): string | undefined {
    const values = (req.headers.cookie ?? "").split(";").map((s) => s.trim()).filter((s) => s.startsWith("tomo_web="));
    return values.length === 1 ? values[0].slice("tomo_web=".length) : undefined;
  }
}
