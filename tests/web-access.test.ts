import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebAccess } from "../src/web/access.js";
import { loadWebToken } from "../src/web/token-store.js";
import { parseWebConfig } from "../src/web/config.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const request = (cookie = "") => ({ headers: { cookie } }) as IncomingMessage;
const token = "a".repeat(64);
const origin = "http://127.0.0.1:9465";
function login(access: WebAccess, target = origin) {
  let cookie = "";
  const res = { setHeader(_key: string, value: string) { cookie = value; } } as ServerResponse;
  const session = access.bootstrap(request(), res, new URL(`${target}/api/v1/bootstrap?t=${token}`), target);
  return { session, cookie, req: request(cookie.split(";")[0]) };
}

describe("web access authentication", () => {
  it("requires a valid token initially and accepts an authenticated cookie after a child restart", () => {
    const access = new WebAccess(token);
    for (const query of ["", "?t=wrong", `?t=${"b".repeat(64)}`, `?t=${token}&t=${token}`]) {
      expect(() => access.bootstrap(request(), {} as ServerResponse, new URL(`${origin}/${query}`), origin)).toThrow("authentication_required");
    }
    const signed = login(access);
    expect(signed.cookie).toContain("HttpOnly; SameSite=Strict; Path=/api/v1");
    expect(signed.cookie).not.toContain(token);
    expect(new WebAccess(token).bootstrap(signed.req, {} as ServerResponse, new URL(origin), origin)).toBe(signed.session);
    expect(() => new WebAccess("b".repeat(64)).require(signed.req, origin)).toThrow();
    expect(() => new WebAccess("")).toThrow();
  });
  it("binds cookies to the exact origin, denies forgery/duplicates and expires authentication", () => {
    let now = Date.now(); const access = new WebAccess(token, () => now);
    const signed = login(access);
    expect(() => access.require(signed.req, "https://test-node.test-tailnet.ts.net")).toThrow();
    expect(() => access.require(request(`tomo_web=${signed.session}; tomo_web=${signed.session}`), origin)).toThrow();
    expect(() => access.require(request(`tomo_web=${signed.session.slice(0, -1)}z`), origin)).toThrow();
    expect(login(access, "https://test-node.test-tailnet.ts.net").cookie).toContain("; Secure");
    now += 30 * 24 * 60 * 60_000;
    expect(() => access.require(signed.req, origin)).toThrow();
  });
});

describe("persistent token", () => {
  function setup() { const root = mkdtempSync(join(tmpdir(), "tomo-token-")); roots.push(root); return root; }
  it("creates a private token and reuses it across restarts", () => {
    const root = setup(); const diagnostic = vi.fn();
    const first = loadWebToken(root, diagnostic);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(join(root, "web-token")).mode & 0o777).toBe(0o600);
    expect(loadWebToken(root, diagnostic)).toBe(first);
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(first);
  });
  it("replaces malformed or wrong-mode entries without following a symlink", () => {
    const root = setup(); const path = join(root, "web-token");
    writeFileSync(path, token, { mode: 0o644 }); chmodSync(path, 0o644);
    expect(loadWebToken(root, () => {})).not.toBe(token);
    writeFileSync(path, "bad");
    expect(loadWebToken(root, () => {})).toMatch(/^[a-f0-9]{64}$/);
    rmSync(path); const target = join(root, "unrelated"); writeFileSync(target, "unchanged"); symlinkSync(target, path);
    loadWebToken(root, () => {});
    expect(readFileSync(target, "utf8")).toBe("unchanged");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it("refuses a directory writable by other OS users", () => {
    const root = setup(); chmodSync(root, 0o777);
    expect(() => loadWebToken(root, () => {})).toThrow("Unsafe");
  });
});

it("accepts only an exact HTTPS Serve origin in optional configuration", () => {
  expect(parseWebConfig({ externalOrigin: "https://test-node.test-tailnet.ts.net" }).enabled).toBe(true);
  for (const externalOrigin of ["http://test-node.test-tailnet.ts.net", "https://*.ts.net", "https://example.com", "https://test-node.test-tailnet.ts.net/", "https://test-node.test-tailnet.ts.net/path", "https://user@test-node.test-tailnet.ts.net"]) {
    expect(parseWebConfig({ externalOrigin }).enabled).toBe(false);
  }
});
