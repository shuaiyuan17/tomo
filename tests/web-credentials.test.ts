import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { log } from "../src/logger.js";
import { WebSupervisor } from "../src/web/supervisor.js";
import { WebChannel } from "../src/channels/web.js";
import { WebRequestJournal } from "../src/web/request-journal.js";
import { WatchBus } from "../src/watch/bus.js";
import { CREDENTIAL_REQUEST_TIMEOUT_MS, CredentialBroker } from "../src/credentials/broker.js";
import { captureChannelFor } from "../src/credentials/capture.js";
import { BrokerStateFile, MemoryBackend } from "../src/credentials/store.js";
import { clearSecretValuesForTests } from "../src/credentials/redactor.js";
import type { WebBootstrap } from "../src/web/protocol.js";

// END TO END through the real web process: the broker opens a card over SSE,
// the browser answers on POST /credentials/<id> (exact Origin, cookie, CSRF,
// epoch), the supervisor's RPC hands it to broker.fulfill. Then the value is
// looked for everywhere it could have leaked: every SSE frame, every response
// body, every file under the runtime home (requests.jsonl included), the
// supervisor's diagnostics and the daemon's log calls.
const FAKE = "fake-web-credential-0d93e1";
const owner = { name: "owner", telegram: ["1001"], imessage: [] as string[] };
const WEB = { channelName: "web", chatId: "owner" };

let root: string;
let web: WebChannel;
let supervisor: WebSupervisor;
let broker: CredentialBroker;
let backend: MemoryBackend;
let now: number;
let notes: string[];
let diagnostics: string[];
let bodies: string[];
let base: string;
let boot: WebBootstrap;
let cookie: string;
let sse: { text: () => string; stop: () => void };

const headers = (extra: Record<string, string | undefined> = {}) => Object.fromEntries(Object.entries({
  "x-tomo-request": "1", "sec-fetch-site": "same-origin", cookie, origin: base,
  "content-type": "application/json", "x-tomo-csrf": boot.csrfToken, "x-tomo-epoch": boot.epoch, ...extra,
}).filter((entry): entry is [string, string] => entry[1] !== undefined));

async function post(path: string, body: unknown, extra: Record<string, string | undefined> = {}): Promise<{ status: number; body: string }> {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: headers(extra), body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await response.text();
  bodies.push(text);
  return { status: response.status, body: text };
}
const answer = (id: string, body: unknown, extra: Record<string, string | undefined> = {}) => post(`/api/v1/credentials/${id}`, body, extra);

async function bootstrap(): Promise<WebBootstrap> {
  const token = readFileSync(join(root, "web-token"), "utf8").trim();
  const response = await fetch(`${base}/api/v1/bootstrap?t=${token}`, { headers: { "x-tomo-request": "1", "sec-fetch-site": "same-origin" } });
  expect(response.status).toBe(200);
  cookie = response.headers.get("set-cookie")!.split(";")[0];
  const text = await response.text();
  bodies.push(text);
  return JSON.parse(text) as WebBootstrap;
}

function openEvents(): { text: () => string; stop: () => void } {
  const controller = new AbortController();
  let buffer = "";
  void fetch(`${base}/api/v1/events`, { headers: headers(), signal: controller.signal }).then(async (response) => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value);
    }
  }).catch(() => {});
  return { text: () => buffer, stop: () => controller.abort() };
}

/** Every `credential-request` event the stream carried, in order. */
function cardEvents(): Array<{ id: string; name: string } | null> {
  return [...sse.text().matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]) as { type?: string; request?: { id: string; name: string } | null })
    .filter((e) => e.type === "credential-request").map((e) => e.request ?? null);
}

function everything(): string {
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"));
  const logged = Object.values(log).flatMap((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls);
  return JSON.stringify([sse.text(), bodies, files, diagnostics, notes, logged, web.events.after(`${web.events.epoch}:0`)]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), "tomo-web-credentials-"));
  backend = new MemoryBackend();
  now = Date.now();
  notes = []; diagnostics = []; bodies = [];
  web = new WebChannel(owner, new WatchBus(), {
    journal: new WebRequestJournal(join(root, "data", "web", "requests.jsonl")),
    credentials: { current: () => broker.formRequest("web"), submit: (id, input) => broker.fulfill(id, input) },
  });
  web.onMessage(async () => true);
  broker = new CredentialBroker({
    backend,
    stateFile: new BrokerStateFile(join(root, "data", "credentials", "state.json")),
    isOwnerSender: () => true,
    captureChannel: (origin) => captureChannelFor(origin.channelName === "web" ? web : undefined, origin.chatId),
    notifySession: (_key, body) => notes.push(body),
    now: () => now,
  });
  supervisor = new WebSupervisor(web, { tomoHome: root, owner, sessionsDir: join(root, "sessions"), sdkSessionsDir: join(root, "sdk"), port: 0,
    diagnostic: (message) => diagnostics.push(message) });
  web.attach(supervisor);
  await web.start();
  base = `http://127.0.0.1:${supervisor.status().port}`;
  boot = await bootstrap();
  sse = openEvents();
  await expect.poll(() => sse.text()).toContain("event: snapshot");
});

afterEach(async () => {
  sse?.stop();
  broker?.shutdown();
  await supervisor?.stop();
  await web?.stop();
  clearSecretValuesForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("the web UI's credential card, end to end", () => {
  it("opens the card over SSE and in the bootstrap, stores the value, and the value appears nowhere else", async () => {
    // An ordinary web message first, so requests.jsonl exists and is checked too.
    expect((await post("/api/v1/messages", { requestId: randomUUID(), text: "please set up github" })).status).toBe(202);

    expect(await broker.request("github", "push to my repo", "dm:owner", WEB)).toMatchObject({ ok: true, channel: "web" });
    await expect.poll(() => cardEvents().length).toBe(1);
    const card = cardEvents()[0]!;
    expect(card).toMatchObject({ name: "github" });
    // A reload still shows it.
    boot = await bootstrap();
    expect(boot.credentialRequest).toEqual({ id: card.id, name: "github", purpose: "push to my repo", expiresAt: now + CREDENTIAL_REQUEST_TIMEOUT_MS });

    const stored = await answer(card.id, { value: FAKE });
    expect(stored).toEqual({ status: 200, body: JSON.stringify({ status: "stored" }) });
    expect(backend.items.get("github")).toBe(FAKE);
    await expect.poll(() => cardEvents().at(-1)).toBeNull();
    expect((await bootstrap()).credentialRequest).toBeUndefined();
    expect(notes.at(-1)).toContain("secret://github");

    expect(existsSync(join(root, "data", "web", "requests.jsonl"))).toBe(true);
    expect(readFileSync(join(root, "data", "web", "requests.jsonl"), "utf8")).toContain("please set up github");
    expect(everything()).not.toContain(FAKE);
  }, 20_000);

  it("needs the exact origin, the cookie, CSRF and the current epoch, and echoes nothing back", async () => {
    await broker.request("x", "p", "dm:owner", WEB);
    await expect.poll(() => cardEvents().length).toBe(1);
    const { id } = cardEvents()[0]!;
    expect((await answer(id, { value: FAKE }, { "x-tomo-csrf": "nope" })).status).toBe(403);
    const stale = await answer(id, { value: FAKE }, { "x-tomo-epoch": randomUUID() });
    expect(stale).toEqual({ status: 409, body: JSON.stringify({ error: "epoch_changed" }) });
    expect((await answer(id, { value: FAKE }, { "x-tomo-epoch": undefined })).status).toBe(409);
    expect((await answer(id, { value: FAKE }, { origin: "http://evil.test" })).status).toBe(403);
    expect((await answer(id, { value: FAKE }, { cookie: undefined })).status).toBe(401);
    // Refused in the web process, before the daemon, with a fixed code.
    expect(await answer(id, { value: FAKE, extra: 1 })).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_credential" }) });
    expect(await answer(id, { value: "" })).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_credential" }) });
    expect(await answer(id, `{"value": "${FAKE}"`)).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_json" }) });
    expect((await answer("not-a-uuid", { value: FAKE })).status).toBe(404);
    expect(backend.items.size).toBe(0);
    // Still open after all of that.
    expect((await bootstrap()).credentialRequest?.id).toBe(id);
    expect(everything()).not.toContain(FAKE);
  }, 20_000);

  it("answers a wrong id with 409, an expired request with 410, and a bad value with 400 (still open)", async () => {
    await broker.request("x", "p", "dm:owner", WEB);
    await expect.poll(() => cardEvents().length).toBe(1);
    const { id } = cardEvents()[0]!;
    expect(await answer(randomUUID(), { value: FAKE })).toEqual({ status: 409, body: JSON.stringify({ error: "credential_unknown" }) });
    expect(await answer(id, { value: "abc" })).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_value" }) });
    boot = await bootstrap();
    expect(boot.credentialRequest?.id).toBe(id);
    now += CREDENTIAL_REQUEST_TIMEOUT_MS + 1;
    expect(await answer(id, { value: FAKE })).toEqual({ status: 410, body: JSON.stringify({ error: "credential_expired" }) });
    await expect.poll(() => cardEvents().at(-1)).toBeNull();
    expect(notes.at(-1)).toContain("timed out");
    expect(backend.items.size).toBe(0);
    expect(everything()).not.toContain(FAKE);
  }, 20_000);

  it("refuses: the card's cancel ends the request, and the session is told", async () => {
    await broker.request("x", "p", "dm:owner", WEB);
    await expect.poll(() => cardEvents().length).toBe(1);
    const { id } = cardEvents()[0]!;
    expect(await answer(id, { cancel: true })).toEqual({ status: 200, body: JSON.stringify({ status: "cancelled" }) });
    expect(notes.at(-1)).toContain("refused");
    expect(await answer(id, { value: FAKE })).toMatchObject({ status: 409 });
  }, 20_000);
});
