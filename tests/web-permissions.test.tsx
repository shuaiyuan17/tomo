import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { WebSupervisor } from "../src/web/supervisor.js";
import { WebChannel } from "../src/channels/web.js";
import { WatchBus } from "../src/watch/bus.js";
import type { WebBootstrap, WebPermissionDecision, WebPermissionRequest } from "../src/web/protocol.js";
import { PermissionCard, permissionError } from "../web/src/permission-card.js";
import { decidePermission } from "../web/src/api.js";

const owner = { name: "owner", telegram: ["1001"], imessage: [] as string[] };
const request: WebPermissionRequest = {
  id: "7a1c2a9e-0000-4000-8000-000000000001", code: "K7Q", group: "Weekend project", path: "/srv/checkouts/app",
  access: "write", reason: "run the test suite", command: "cd /srv/checkouts/app && npm test", expiresAt: Date.now() + 120_000,
};

describe("the permission card", () => {
  const bootstrap = { epoch: "e0e0e0e0-0000-4000-8000-000000000000", csrfToken: "csrf" } as unknown as WebBootstrap;

  it("shows the group, the access, the path and the unverified reason, with exactly three answers", () => {
    const html = renderToStaticMarkup(createElement(PermissionCard, { request, bootstrap, refresh: async () => bootstrap }));
    for (const text of ["Weekend project", "Write", "/srv/checkouts/app", "run the test suite", "not verified"]) expect(html).toContain(text);
    const buttons = [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
    expect(buttons).toEqual(["Triggering call", "Allow once", "Always allow", "Deny"]);
  });

  it("keeps the triggering call folded away until opened", () => {
    const html = renderToStaticMarkup(createElement(PermissionCard, { request, bootstrap, refresh: async () => bootstrap }));
    expect(html).toContain("Triggering call");
    expect(html).not.toContain("npm test");
    const plain = renderToStaticMarkup(createElement(PermissionCard, { request: { ...request, command: undefined }, bootstrap, refresh: async () => bootstrap }));
    expect(plain).not.toContain("Triggering call");
  });

  it("answers on its own route with CSRF and the epoch, and words the fixed refusal codes", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: "allowed_once" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(decidePermission(request.id, "once", bootstrap, async () => bootstrap)).resolves.toEqual({ status: "allowed_once" });
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`/api/v1/permissions/${request.id}`);
      expect(init.body).toBe(JSON.stringify({ decision: "once" }));
      expect(init.headers).toMatchObject({ "x-tomo-csrf": "csrf", "x-tomo-epoch": bootstrap.epoch });
    } finally { vi.unstubAllGlobals(); }
    expect(permissionError("permission_closed")).toContain("expired");
    expect(permissionError("permission_config_unwritable")).toContain("config.json");
    expect(permissionError("whatever")).toBe("Could not send. Try again.");
  });
});

// END TO END through the real web process: the card arrives in the bootstrap
// and over SSE, and the answer goes through POST /permissions/<id> under the
// same gate as every write.
describe("the permission card through the web process", () => {
  let root: string;
  let web: WebChannel;
  let supervisor: WebSupervisor;
  let open: WebPermissionRequest[];
  let decided: { id: string; decision: WebPermissionDecision }[];
  let revoked: { groupKey: string; path: string }[];
  let base: string;
  let boot: WebBootstrap;
  let cookie: string;

  async function bootstrap(): Promise<WebBootstrap> {
    const token = readFileSync(join(root, "web-token"), "utf8").trim();
    const response = await fetch(`${base}/api/v1/bootstrap?t=${token}`, { headers: { "x-tomo-request": "1", "sec-fetch-site": "same-origin" } });
    cookie = response.headers.get("set-cookie")!.split(";")[0];
    return await response.json() as WebBootstrap;
  }
  async function answer(id: string, body: unknown, extra: Record<string, string | undefined> = {}) {
    return post(`/api/v1/permissions/${id}`, body, extra);
  }
  async function post(path: string, body: unknown, extra: Record<string, string | undefined> = {}) {
    const headers = Object.fromEntries(Object.entries({ "x-tomo-request": "1", "sec-fetch-site": "same-origin", cookie, origin: base,
      "content-type": "application/json", "x-tomo-csrf": boot.csrfToken, "x-tomo-epoch": boot.epoch, ...extra })
      .filter((e): e is [string, string] => e[1] !== undefined));
    const response = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.text() };
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "tomo-web-permissions-"));
    open = [request]; decided = []; revoked = [];
    web = new WebChannel(owner, new WatchBus(), {
      permissions: {
        current: () => open,
        decide: (id, decision) => {
          if (!open.some((r) => r.id === id)) return { ok: false, status: 409, code: "permission_unknown" };
          decided.push({ id, decision }); open = [];
          return { ok: true, outcome: decision === "once" ? "allowed_once" : decision === "always" ? "allowed_always" : "denied" };
        },
        revoke: (groupKey, path) => { revoked.push({ groupKey, path }); return !path.includes("unwritable"); },
      },
    });
    web.onMessage(async () => true);
    supervisor = new WebSupervisor(web, { tomoHome: root, owner, sessionsDir: join(root, "sessions"), sdkSessionsDir: join(root, "sdk"), port: 0 });
    web.attach(supervisor);
    await web.start();
    base = `http://127.0.0.1:${supervisor.status().port}`;
    boot = await bootstrap();
  });

  afterEach(async () => {
    await supervisor?.stop();
    await web?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("is in the bootstrap, and an answer reaches the broker once", async () => {
    expect(boot.permissionRequests).toEqual([request]);
    expect(await answer(request.id, { decision: "always" })).toEqual({ status: 200, body: JSON.stringify({ status: "allowed_always" }) });
    expect(decided).toEqual([{ id: request.id, decision: "always" }]);
    expect(await answer(request.id, { decision: "once" })).toEqual({ status: 409, body: JSON.stringify({ error: "permission_unknown" }) });
    expect((await bootstrap()).permissionRequests).toBeUndefined();
  }, 20_000);

  it("needs CSRF, the current epoch and a well-formed body", async () => {
    expect((await answer(request.id, { decision: "once" }, { "x-tomo-csrf": "nope" })).status).toBe(403);
    expect((await answer(request.id, { decision: "once" }, { "x-tomo-epoch": randomUUID() })).status).toBe(409);
    expect((await answer(request.id, { decision: "once" }, { origin: "http://evil.test" })).status).toBe(403);
    expect(await answer(request.id, { decision: "maybe" })).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_decision" }) });
    expect(await answer(request.id, { decision: "once", extra: 1 })).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_decision" }) });
    expect(decided).toEqual([]);
  }, 20_000);

  it("revokes an Always allow for the owner, under the same gate", async () => {
    const revoke = (body: unknown, extra: Record<string, string | undefined> = {}) => post("/api/v1/permissions/revoke", body, extra);
    const grant = { groupKey: "telegram:-100777", path: "/srv/checkouts/app" };
    expect((await revoke(grant, { "x-tomo-csrf": "nope" })).status).toBe(403);
    expect((await revoke(grant, { "x-tomo-epoch": randomUUID() })).status).toBe(409);
    expect((await revoke(grant, { origin: "http://evil.test" })).status).toBe(403);
    expect((await revoke(grant, { cookie: undefined })).status).toBe(401);
    expect(await revoke({ ...grant, extra: 1 })).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_revoke" }) });
    expect(revoked).toEqual([]);
    expect(await revoke(grant)).toEqual({ status: 200, body: JSON.stringify({ status: "revoked" }) });
    expect(revoked).toEqual([grant]);
    expect(await revoke({ ...grant, path: "/srv/unwritable" })).toEqual({ status: 503, body: JSON.stringify({ error: "permission_config_unwritable" }) });
  }, 20_000);

  it("pushes the open requests over the event stream", async () => {
    const events: unknown[] = [];
    web.events.subscribe(({ event }) => events.push(event));
    web.publishPermissionRequests([{ ...request, extra: "dropped" } as WebPermissionRequest]);
    web.publishPermissionRequests([]);
    expect(events).toEqual([{ type: "permission-requests", requests: [request] }, { type: "permission-requests", requests: [] }]);
  });
});
