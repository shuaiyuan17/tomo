import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebError } from "./protocol.js";

export const securityHeaders = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "cross-origin-resource-policy": "same-origin",
};

export function checkRequest(req: IncomingMessage, port: number, api: boolean, externalOrigin?: string): string {
  const origins = [`http://127.0.0.1:${port}`, ...(externalOrigin ? [externalOrigin] : [])];
  const origin = origins.find((value) => new URL(value).host === req.headers.host);
  let hostCount = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === "host") hostCount++;
  if (hostCount !== 1 || !origin || !req.url?.startsWith("/") || req.url.startsWith("//")) {
    throw new WebError(403, "invalid_host");
  }
  if (req.headers.origin !== undefined && req.headers.origin !== origin) throw new WebError(403, "invalid_origin");
  const site = req.headers["sec-fetch-site"];
  if ((site === "cross-site" || site === "same-site") && !(!api && isTopLevelNavigation(req))) {
    throw new WebError(403, "cross_origin_request");
  }
  if (api && (req.headers["x-tomo-request"] !== "1" || req.headers["sec-fetch-site"] !== "same-origin")) {
    throw new WebError(403, "same_origin_required");
  }
  if (api && req.method !== "GET" && req.headers.origin !== origin) throw new WebError(403, "origin_required");
  return origin;
}

/**
 * A top-level GET of the page itself. It only fetches the static app shell:
 * every API call it then makes is same-origin and checked on its own, the
 * shell carries no data, and `frame-ancestors 'none'` stops framing. Phone
 * browsers re-issue a discarded tab's original navigation, still labelled
 * cross-site when the page was first opened from another app (a link in
 * Messages), so refusing it shows a bare error page until a manual reload.
 */
function isTopLevelNavigation(req: IncomingMessage): boolean {
  return (req.method === "GET" || req.method === "HEAD")
    && req.headers["sec-fetch-mode"] === "navigate"
    && req.headers["sec-fetch-dest"] === "document";
}

/** Browser capabilities are process-local, bounded, and never logged. */
export class CsrfTokens {
  private tokens = new Map<string, { token: string; expires: number }>();
  constructor(private readonly now = Date.now) {}

  bootstrap(session: string): string {
    const now = this.now();
    for (const [id, value] of this.tokens) if (value.expires < now) this.tokens.delete(id);
    const found = this.tokens.get(session);
    if (found) return found.token;
    if (this.tokens.size >= 64) throw new WebError(429, "browser_limit");
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(session, { token, expires: now + 12 * 60 * 60_000 });
    return token;
  }

  /** `contentType`: what the body must be (JSON for every mutation but an image upload). */
  verify(req: IncomingMessage, session: string, contentType = "application/json"): void {
    const saved = this.tokens.get(session);
    const actual = req.headers["x-tomo-csrf"];
    if (!saved || saved.expires < this.now() || typeof actual !== "string" || Buffer.byteLength(actual) !== Buffer.byteLength(saved.token)
      || !timingSafeEqual(Buffer.from(actual), Buffer.from(saved.token))) throw new WebError(403, "invalid_csrf");
    if (req.headers["content-type"] !== contentType) throw new WebError(415, contentType === "application/json" ? "json_required" : "content_type_required");
  }

}
