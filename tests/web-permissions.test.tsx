import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { WebChannel } from "../src/channels/web.js";
import { WatchBus } from "../src/watch/bus.js";
import type { WebBootstrap, WebPermissionDecision, WebPermissionRequest } from "../src/web/protocol.js";
import { PermissionCard, PermissionGranted, permissionError } from "../web/src/permission-card.js";
import { startWebProcess, type WebProcess } from "./helpers/web-process.js";

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
    // A button's label is its text between tags (icons render as empty <svg> elements).
    const buttons = [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1].split(/<[^>]*>/).filter(Boolean).join(""));
    expect(buttons).toEqual(["Triggering call", "Allow once", "Always allow", "Deny"]);
  });

  it("says what Allow once covers, and an Always allow leaves its grant ID on screen", () => {
    const html = renderToStaticMarkup(createElement(PermissionCard, { request, bootstrap, refresh: async () => bootstrap }));
    expect(html).toContain("Allow once covers file reads and writes; shell access needs Always allow.");
    const done = renderToStaticMarkup(createElement(PermissionGranted, { granted: { grantId: "G-ABCDEF", group: "Weekend project", path: "/srv/checkouts/app" }, onClose: () => {} }));
    expect(done).toContain("Always allowed · ID");
    expect(done).toMatch(/data-testid="permission-grant-id">G-ABCDEF</);
    expect(done).toContain('aria-label="Copy grant ID"');
  });

  it("keeps the triggering call folded away until opened", () => {
    const html = renderToStaticMarkup(createElement(PermissionCard, { request, bootstrap, refresh: async () => bootstrap }));
    expect(html).toContain("Triggering call");
    expect(html).not.toContain("npm test");
    const plain = renderToStaticMarkup(createElement(PermissionCard, { request: { ...request, command: undefined }, bootstrap, refresh: async () => bootstrap }));
    expect(plain).not.toContain("Triggering call");
  });

  it("words the fixed refusal codes (the answer's own route: web-api.test.ts)", () => {
    expect(permissionError("permission_closed")).toContain("expired");
    expect(permissionError("permission_config_unwritable")).toContain("config.json");
    expect(permissionError("whatever")).toBe("Could not send. Try again.");
  });
});

// END TO END through the real web process: the card arrives in the bootstrap,
// and the answer goes through POST /permissions/<id> under the same gate as
// every write (its rows are in web-http.test.ts's write-gate table). One web
// process for the file; each test starts from one open request.
describe("the permission card through the web process", () => {
  let root: string;
  let web: WebChannel;
  let child: WebProcess;
  let open: WebPermissionRequest[];
  let decided: { id: string; decision: WebPermissionDecision }[];
  let revoked: string[];
  let boot: WebBootstrap;
  const answer = (id: string, body: unknown) => child.post(`/api/v1/permissions/${id}`, body);

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "tomo-web-permissions-"));
    web = new WebChannel(owner, new WatchBus(), {
      permissions: {
        current: () => open,
        decide: (id, decision) => {
          if (!open.some((r) => r.id === id)) return { ok: false, status: 409, code: "permission_unknown" };
          decided.push({ id, decision }); open = [];
          return { ok: true, outcome: decision === "once" ? "allowed_once" : decision === "always" ? "allowed_always" : "denied" };
        },
        revoke: (grantId) => { revoked.push(grantId); return grantId === "G-ABCDEF" ? "revoked" : grantId === "G-UNWRTB" ? "unwritable" : "unknown"; },
      },
    });
    web.onMessage(async () => true);
    child = await startWebProcess(web, { tomoHome: root, owner, sessionsDir: join(root, "sessions"), sdkSessionsDir: join(root, "sdk") });
  }, 20_000);
  beforeEach(async () => {
    open = [request]; decided = []; revoked = [];
    boot = await child.bootstrap();
  });
  afterAll(async () => {
    await child?.stop();
    await web?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("is in the bootstrap, and an answer reaches the broker once", async () => {
    expect(boot.permissionRequests).toEqual([request]);
    expect(await answer(request.id, { decision: "always" })).toEqual({ status: 200, body: JSON.stringify({ status: "allowed_always" }) });
    expect(decided).toEqual([{ id: request.id, decision: "always" }]);
    expect(await answer(request.id, { decision: "once" })).toEqual({ status: 409, body: JSON.stringify({ error: "permission_unknown" }) });
    expect((await child.bootstrap()).permissionRequests).toBeUndefined();
  });

  it("refuses a malformed answer in the web process, before the broker", async () => {
    expect(await answer(request.id, { decision: "maybe" })).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_decision" }) });
    expect(await answer(request.id, { decision: "once", extra: 1 })).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_decision" }) });
    expect(decided).toEqual([]);
  });

  it("revokes an Always allow for the owner, and names each refusal", async () => {
    const revoke = (body: unknown) => child.post("/api/v1/permissions/revoke", body);
    const grant = { grantId: "G-ABCDEF" };
    expect(await revoke({ ...grant, extra: 1 })).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_revoke" }) });
    expect(revoked).toEqual([]);
    expect(await revoke(grant)).toEqual({ status: 200, body: JSON.stringify({ status: "revoked" }) });
    expect(revoked).toEqual(["G-ABCDEF"]);
    expect(await revoke({ grantId: "G-UNWRTB" })).toEqual({ status: 503, body: JSON.stringify({ error: "permission_config_unwritable" }) });
    expect(await revoke({ grantId: "G-QQQQQQ" })).toEqual({ status: 404, body: JSON.stringify({ error: "grant_unknown" }) });
    expect(await revoke({ grantId: "K7Q" })).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_revoke" }) });
  });
});

describe("the permission card's events", () => {
  it("pushes the open requests over the event stream, without fields the card does not show", async () => {
    const web = new WebChannel(owner, new WatchBus());
    const events: unknown[] = [];
    web.events.subscribe(({ event }) => events.push(event));
    web.publishPermissionRequests([{ ...request, extra: "dropped" } as WebPermissionRequest]);
    web.publishPermissionRequests([]);
    expect(events).toEqual([{ type: "permission-requests", requests: [request] }, { type: "permission-requests", requests: [] }]);
    await web.stop();
  });
});
