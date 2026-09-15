import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startWebHttp } from "../src/web/http.js";
import { WebData } from "../src/web/data.js";
import { SessionStore } from "../src/sessions/store.js";
import { WebChannel } from "../src/channels/web.js";
import { webSessionId } from "../src/web/owner.js";
import { checkRequest, CsrfTokens } from "../src/web/security.js";
import type { WebBootstrap } from "../src/web/protocol.js";
import type { IncomingMessage, ServerResponse } from "node:http";

let root: string;
let service: Awaited<ReturnType<typeof startWebHttp>>;
let channel: WebChannel;
let handoff: ReturnType<typeof vi.fn>;
let cookie: string;
let bootstrap: WebBootstrap;
const baseHeaders = { "x-tomo-request": "1", "sec-fetch-site": "same-origin" };

async function call(path: string, options: { method?: string; headers?: Record<string, string | undefined>; body?: string } = {}) {
  return new Promise<{ status: number; text: string; headers: IncomingMessage["headers"] }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: service.port, path, method: options.method ?? "GET",
      headers: Object.fromEntries(Object.entries({ ...baseHeaders, ...options.headers }).filter(([, value]) => value !== undefined)) }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (part) => { text += part; });
      res.on("end", () => resolve({ status: res.statusCode!, text, headers: res.headers }));
    });
    req.on("error", reject); req.end(options.body);
  });
}
function mutationHeaders() { return { origin: `http://127.0.0.1:${service.port}`, cookie,
  "content-type": "application/json", "x-tomo-csrf": bootstrap.csrfToken, "x-tomo-epoch": bootstrap.epoch }; }

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tomo-web-http-"));
  const sessionsDir = join(root, "sessions"); const sdkSessionsDir = join(root, "sdk");
  const assetsDir = join(root, "assets"); mkdirSync(join(assetsDir, "assets"), { recursive: true });
  writeFileSync(join(assetsDir, "index.html"), "<!doctype html><title>Tomo</title>");
  writeFileSync(join(assetsDir, "assets", "app-test.js"), "export {};");
  const identities = [{ name: "owner", channels: { telegram: "test-owner" }, replyPolicy: "last-active" as const }];
  const store = new SessionStore(sessionsDir, 20, sdkSessionsDir);
  store.touchSession("telegram:-1"); store.setChatTitle("telegram:-1", "Test group");
  store.append("telegram:-1", { role: "user", content: "Group history", timestamp: Date.now(), channel: "telegram" });
  store.touchSession("dm:peer");
  channel = new WebChannel(identities); handoff = vi.fn(async () => true); channel.onMessage(handoff);
  service = await startWebHttp(0, { assetsDir, data: new WebData({ sessionsDir, sdkSessionsDir, identities }),
    subscribe: (fn) => channel.events.subscribe(fn), rpc: async (input) => {
      if (input.method === "message") return channel.receive(input.input);
      if (input.method === "request") return channel.request(input.requestId);
      return { snapshot: channel.snapshot(), replay: input.cursor ? channel.events.after(input.cursor) : null };
    } });
  const response = await call("/api/v1/bootstrap");
  expect(response.status).toBe(200);
  bootstrap = JSON.parse(response.text);
  cookie = response.headers["set-cookie"]![0].split(";")[0];
});
afterEach(async () => { await service?.close(); await channel?.stop(); rmSync(root, { recursive: true, force: true }); });

describe("local HTTP boundary", () => {
  it.each([
    ["host", "evil.example"], ["host", "localhost:9465"], ["origin", "null"], ["origin", "https://evil.example"],
    ["sec-fetch-site", "cross-site"], ["sec-fetch-site", "same-site"], ["sec-fetch-site", undefined], ["x-tomo-request", undefined],
  ])("denies hostile/missing %s=%s before private bootstrap", async (key, value) => {
    const response = await call("/api/v1/bootstrap", { headers: { [key!]: value } });
    expect(response.status).toBe(403);
    expect(response.text).not.toContain("csrfToken");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
  it("requires Origin, JSON, and a matching cookie-bound CSRF token before mutation", async () => {
    for (const headers of [{ origin: undefined }, { cookie: undefined }, { "x-tomo-csrf": "wrong" },
      { "x-tomo-csrf": "é".repeat(43) }, { "content-type": "text/plain" }]) {
      const response = await call("/api/v1/messages", { method: "POST", headers: { ...mutationHeaders(), ...headers },
        body: JSON.stringify({ requestId: randomUUID(), text: "blocked" }) });
      expect([403, 415]).toContain(response.status);
    }
    expect(handoff).not.toHaveBeenCalled();
    const accepted = await call("/api/v1/messages", { method: "POST", headers: mutationHeaders(),
      body: JSON.stringify({ requestId: randomUUID(), text: "accepted" }) });
    expect(accepted.status).toBe(202); expect(handoff).toHaveBeenCalledOnce();
    expect(bootstrap.csrfToken).not.toBe(cookie);
  });
  it("offers only owner DM and read-only groups, rejecting forged group sends", async () => {
    expect(bootstrap.sessions.map((s) => [s.kind, s.writable]).sort()).toEqual([["dm", true], ["group", false]]);
    expect(JSON.stringify(bootstrap)).not.toContain("dm:peer");
    expect(JSON.stringify(bootstrap)).not.toContain("test-owner");
    const id = webSessionId("telegram:-1");
    const history = await call(`/api/v1/sessions/${id}/messages`);
    expect(history.status).toBe(200); expect(JSON.parse(history.text).messages[0].content).toBe("Group history");
    const denied = await call("/api/v1/messages", { method: "POST", headers: mutationHeaders(),
      body: JSON.stringify({ requestId: randomUUID(), targetId: id, text: "blocked" }) });
    expect(denied.status).toBe(403); expect(handoff).not.toHaveBeenCalled();
  });
  it("rejects malformed, extra-field, oversized and non-JSON bodies", async () => {
    for (const body of ["{", JSON.stringify({ requestId: randomUUID(), text: "", senderId: "test-owner" }),
      JSON.stringify({ requestId: randomUUID(), text: "x".repeat(40_000) })]) {
      const response = await call("/api/v1/messages", { method: "POST", headers: mutationHeaders(), body });
      expect([400, 413]).toContain(response.status);
    }
    expect(handoff).not.toHaveBeenCalled();
  });
  it("serves only packaged assets with CSP, and denies preflights and path escapes", async () => {
    const page = await call("/"); expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["content-security-policy"]).not.toContain("unsafe-inline");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect((await call("/assets/app-test.js")).headers["content-type"]).toContain("javascript");
    writeFileSync(join(root, "private.js"), "private data");
    symlinkSync(join(root, "private.js"), join(root, "assets", "assets", "escape.js"));
    for (const path of ["/config.json", "/../private.js", "/assets/escape.js", "/assets/%2e%2e/private.js"]) {
      const response = await call(path); expect(response.status).toBe(404); expect(response.text).not.toContain("private data");
    }
    expect((await call("/api/v1/messages", { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status).toBe(403);
  });
  it("sends an SSE snapshot and live completed blocks without a browser read acknowledgment", async () => {
    const requestId = randomUUID();
    await channel.receive({ requestId, text: "stream" });
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${service.port}/api/v1/events`, { headers: baseHeaders, signal: controller.signal });
    const reader = response.body!.getReader();
    let text = new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain("event: snapshot");
    await channel.send({ chatId: requestId, text: "completed block" });
    while (!text.includes("completed block")) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('"type":"block"');
    controller.abort(); await reader.cancel().catch(() => {});
    expect(channel.snapshot().blocks[0].text).toBe("completed block");
  });
});

it("rejects duplicate Host and absolute-form targets", () => {
  const fake = (rawHeaders: string[], url: string) => ({ rawHeaders, headers: { host: "127.0.0.1:9465" }, url, method: "GET" }) as IncomingMessage;
  expect(() => checkRequest(fake(["Host", "127.0.0.1:9465", "Host", "evil.example"], "/"), 9465, false)).toThrow();
  expect(() => checkRequest(fake(["Host", "127.0.0.1:9465"], "http://127.0.0.1:9465/"), 9465, false)).toThrow();
});

it("expires CSRF capabilities and does not accept a token from another browser", () => {
  let now = 0;
  const tokens = new CsrfTokens(() => now);
  let cookie = "";
  const req = { headers: {} } as IncomingMessage;
  const token = tokens.bootstrap(req, { setHeader(_key: string, value: string) { cookie = value.split(";")[0]; } } as ServerResponse);
  const verified = { headers: { cookie, "x-tomo-csrf": token, "content-type": "application/json" } } as IncomingMessage;
  expect(() => tokens.verify(verified)).not.toThrow();
  expect(() => tokens.verify({ headers: { ...verified.headers, cookie: "tomo_web=other" } } as IncomingMessage)).toThrow();
  now = 12 * 60 * 60_000 + 1;
  expect(() => tokens.verify(verified)).toThrow();
});
