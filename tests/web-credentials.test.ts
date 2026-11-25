import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { log } from "../src/logger.js";
import { WebChannel } from "../src/channels/web.js";
import { WebRequestJournal } from "../src/web/request-journal.js";
import { WatchBus } from "../src/watch/bus.js";
import { CREDENTIAL_REQUEST_TIMEOUT_MS, CredentialBroker } from "../src/credentials/broker.js";
import { captureChannelFor } from "../src/credentials/capture.js";
import { BrokerStateFile, MemoryBackend } from "../src/credentials/store.js";
import { clearSecretValuesForTests } from "../src/credentials/redactor.js";
import type { WebBootstrap } from "../src/web/protocol.js";
import { startWebProcess, type WebProcess } from "./helpers/web-process.js";
import type { Headers } from "./helpers/web-http.js";

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
let child: WebProcess;
let broker: CredentialBroker;
let backend: MemoryBackend;
let now: number;
let notes: string[];
let diagnostics: string[];
let bodies: string[];
let sse: { text: () => string; stop: () => void };
let run = 0;

async function post(path: string, body: unknown, extra: Headers = {}): Promise<{ status: number; body: string }> {
  const response = await child.post(path, body, extra);
  bodies.push(response.body);
  return response;
}
const answer = (id: string, body: unknown, extra: Headers = {}) => post(`/api/v1/credentials/${id}`, body, extra);
async function bootstrap(): Promise<WebBootstrap> {
  const boot = await child.bootstrap();
  bodies.push(JSON.stringify(boot));
  return boot;
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

// One web process for the file (a child takes about half a second to start);
// the broker, its state file, the stream and every record of what was seen are per test.
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "tomo-web-credentials-"));
  diagnostics = [];
  web = new WebChannel(owner, new WatchBus(), {
    journal: new WebRequestJournal(join(root, "data", "web", "requests.jsonl")),
    credentials: { current: () => broker.formRequest("web"), submit: (id, input) => broker.fulfill(id, input) },
  });
  web.onMessage(async () => true);
  child = await startWebProcess(web, { tomoHome: root, owner, sessionsDir: join(root, "sessions"), sdkSessionsDir: join(root, "sdk"),
    diagnostic: (message) => diagnostics.push(message) });
}, 20_000);
afterAll(async () => {
  await child?.stop();
  await web?.stop();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  backend = new MemoryBackend();
  now = Date.now();
  notes = []; bodies = [];
  broker = new CredentialBroker({
    backend,
    stateFile: new BrokerStateFile(join(root, "data", "credentials", `state-${++run}.json`)),
    isOwnerSender: () => true,
    captureChannel: (origin) => captureChannelFor(origin.channelName === "web" ? web : undefined, origin.chatId),
    notifySession: (_key, body) => notes.push(body),
    now: () => now,
  });
  await bootstrap();
  sse = child.openEvents();
  await expect.poll(() => sse.text()).toContain("event: snapshot");
});

afterEach(() => {
  sse?.stop();
  broker?.shutdown();
  clearSecretValuesForTests();
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
    const boot = await bootstrap();
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
  });

  it("echoes nothing back from a refused answer, whichever check refused it", async () => {
    // Which request each check refuses is web-http.test.ts's write-gate table; this
    // is the real web process, and what matters here is that FAKE comes back nowhere.
    await broker.request("x", "p", "dm:owner", WEB);
    await expect.poll(() => cardEvents().length).toBe(1);
    const { id } = cardEvents()[0]!;
    for (const [extra, status, error] of [
      [{ "x-tomo-csrf": "nope" }, 403, "invalid_csrf"],
      [{ "x-tomo-epoch": randomUUID() }, 409, "epoch_changed"],
      [{ "x-tomo-epoch": undefined }, 409, "epoch_changed"],
      [{ origin: "http://evil.test" }, 403, "invalid_origin"],
      [{ cookie: undefined }, 401, "authentication_required"],
    ] as const) {
      expect(await answer(id, { value: FAKE }, extra), JSON.stringify(extra)).toEqual({ status, body: JSON.stringify({ error }) });
    }
    // Refused in the web process, before the daemon, with a fixed code.
    expect(await answer(id, { value: FAKE, extra: 1 })).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_credential" }) });
    expect(await answer(id, { value: "" })).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_credential" }) });
    expect(await answer(id, `{"value": "${FAKE}"`)).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_json" }) });
    expect((await answer("not-a-uuid", { value: FAKE })).status).toBe(404);
    expect(backend.items.size).toBe(0);
    // Still open after all of that.
    expect((await bootstrap()).credentialRequest?.id).toBe(id);
    expect(everything()).not.toContain(FAKE);
  });

  it("answers a wrong id with 409, an expired request with 410, and a bad value with 400 (still open)", async () => {
    await broker.request("x", "p", "dm:owner", WEB);
    await expect.poll(() => cardEvents().length).toBe(1);
    const { id } = cardEvents()[0]!;
    expect(await answer(randomUUID(), { value: FAKE })).toEqual({ status: 409, body: JSON.stringify({ error: "credential_unknown" }) });
    expect(await answer(id, { value: "abc" })).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_value" }) });
    const boot = await bootstrap();
    expect(boot.credentialRequest?.id).toBe(id);
    now += CREDENTIAL_REQUEST_TIMEOUT_MS + 1;
    expect(await answer(id, { value: FAKE })).toEqual({ status: 410, body: JSON.stringify({ error: "credential_expired" }) });
    await expect.poll(() => cardEvents().at(-1)).toBeNull();
    expect(notes.at(-1)).toContain("timed out");
    expect(backend.items.size).toBe(0);
    expect(everything()).not.toContain(FAKE);
  });

  it("refuses: the card's cancel ends the request, and the session is told", async () => {
    await broker.request("x", "p", "dm:owner", WEB);
    await expect.poll(() => cardEvents().length).toBe(1);
    const { id } = cardEvents()[0]!;
    expect(await answer(id, { cancel: true })).toEqual({ status: 200, body: JSON.stringify({ status: "cancelled" }) });
    expect(notes.at(-1)).toContain("refused");
    expect(await answer(id, { value: FAKE })).toMatchObject({ status: 409 });
  });
});
