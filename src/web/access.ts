import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebError } from "./protocol.js";

export const validAccessToken = (value: unknown): value is string => typeof value === "string" && /^tomo_web_[a-f0-9]{64}$/.test(value);
const equal = (left: string, right: string) => Buffer.byteLength(left) === Buffer.byteLength(right)
  && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const SESSION_MS = 30 * 24 * 60 * 60_000;

/** Signed, origin-bound cookies survive a web-child restart. CSRF tokens have
 * a separate, shorter lifetime; renewing one never grants a new login. */
export class WebAccess {
  constructor(private readonly token: string, private readonly now = Date.now) {
    if (!validAccessToken(token)) throw new Error("Web access token required");
  }
  private signature(value: string, origin: string): string {
    return createHmac("sha256", this.token).update(`${origin}\n${value}`).digest("hex");
  }
  session(req: IncomingMessage, origin: string): string | undefined {
    const cookies = (req.headers.cookie ?? "").split(";").map((v) => v.trim()).filter((v) => v.startsWith("tomo_web="));
    if (cookies.length !== 1) return;
    const value = cookies[0].slice("tomo_web=".length);
    const match = /^([a-f0-9]{64})\.(\d{1,16})\.([a-f0-9]{64})$/.exec(value);
    if (!match || Number(match[2]) <= this.now() || Number(match[2]) > this.now() + SESSION_MS
      || !equal(match[3], this.signature(`${match[1]}.${match[2]}`, origin))) return;
    return value;
  }
  require(req: IncomingMessage, origin: string): string {
    const session = this.session(req, origin);
    if (!session) throw new WebError(401, "authentication_required");
    return session;
  }
  bootstrap(req: IncomingMessage, res: ServerResponse, url: URL, origin: string): string {
    const session = this.session(req, origin);
    if (session) return session;
    const supplied = url.searchParams.getAll("t");
    if (supplied.length !== 1 || !validAccessToken(supplied[0]) || !equal(supplied[0], this.token)) {
      throw new WebError(401, "authentication_required");
    }
    const payload = `${randomBytes(32).toString("hex")}.${this.now() + SESSION_MS}`;
    const value = `${payload}.${this.signature(payload, origin)}`;
    res.setHeader("set-cookie", `tomo_web=${value}; HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=${SESSION_MS / 1000}${origin.startsWith("https:") ? "; Secure" : ""}`);
    return value;
  }
}
