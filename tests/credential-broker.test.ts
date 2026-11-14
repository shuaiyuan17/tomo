import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { CREDENTIAL_REQUEST_TIMEOUT_MS, CredentialBroker } from "../src/credentials/broker.js";
import { clearSecretValuesForTests, scrubKnownSecrets } from "../src/credentials/redactor.js";
import { BrokerStateFile, CredentialStoreError, MemoryBackend } from "../src/credentials/store.js";
import { markDefiniteFailure, type Channel, type IncomingMessage, type OutgoingMessage } from "../src/channels/types.js";
import { log } from "../src/logger.js";

const FAKE = "fake-owner-credential-9f3a";
const OWNER = "+15555550123";
const SESSION = "dm:owner";
const HOUR = 60 * 60_000;

function channel(name = "imessage") {
  const sent: OutgoingMessage[] = [];
  const forgotten: string[] = [];
  const settled: string[] = [];
  const ch = {
    name,
    send: vi.fn(async (m: OutgoingMessage) => { sent.push(m); }),
    forgetMessage: (_chat: string, id: string) => { forgotten.push(id); },
    settleMessage: (id: string) => { settled.push(id); },
  } as unknown as Channel;
  return { ch, sent, forgotten, settled, send: ch.send as ReturnType<typeof vi.fn> };
}

let seq = 0;
function reply(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  const text = "rawText" in overrides ? overrides.rawText ?? "" : FAKE;
  return { id: `guid-${++seq}`, chatId: `any;-;${OWNER}`, senderName: "Owner", senderId: OWNER, text, rawText: text, attachmentCount: 0, timestamp: Date.now(), ...overrides };
}
const ordinary = (extra: Partial<IncomingMessage> = {}) => reply({ rawText: "an ordinary message", ...extra });

class FlakyStateFile extends BrokerStateFile {
  failing = true;
  override save(state: Parameters<BrokerStateFile["save"]>[0]): void {
    if (this.failing) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    super.save(state);
  }
}

describe("CredentialBroker", () => {
  let dir: string;
  let backend: MemoryBackend;
  let im: ReturnType<typeof channel>;
  let notes: Array<{ sessionKey: string; body: string }>;
  const statePath = () => join(dir, "state.json");

  function make(opts: { now?: () => number; imessage?: boolean; stateFile?: BrokerStateFile } = {}) {
    return new CredentialBroker({
      backend,
      stateFile: opts.stateFile ?? new BrokerStateFile(statePath()),
      isOwnerSender: (_channel, sender) => sender === OWNER,
      ownerImessage: () => (opts.imessage === false ? null : { channel: im.ch, chatId: OWNER }),
      notifySession: (sessionKey, body) => notes.push({ sessionKey, body }),
      ...(opts.now ? { now: opts.now } : {}),
    });
  }

  function leakSurface(): string {
    const logged = Object.values(log).flatMap((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls);
    const state = existsSync(statePath()) ? readFileSync(statePath(), "utf8") : "";
    return JSON.stringify([notes, im.sent, logged, state]);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tomo-broker-"));
    backend = new MemoryBackend();
    im = channel();
    notes = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearSecretValuesForTests();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("request and capture", () => {
    it("takes the owner's next iMessage as the value and puts it nowhere else", async () => {
      const broker = make();
      expect(await broker.request("github", "push to my repo", SESSION)).toMatchObject({ ok: true, ref: "secret://github" });
      const message = reply();
      expect(await broker.handleInbound(im.ch, message)).toBe(true);
      expect(backend.items.get("github")).toBe(FAKE);
      expect(im.forgotten).toEqual([message.id]);
      expect(notes).toEqual([{ sessionKey: SESSION, body: expect.stringContaining("secret://github") }]);
      expect(leakSurface()).not.toContain(FAKE);
      expect(scrubKnownSecrets(`x ${FAKE}`)).toBe("x [REDACTED secret://github]");
      expect(statSync(statePath()).mode & 0o777).toBe(0o600);
    });

    it("stores what was typed when the reply is threaded, not the channel's marker", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION);
      await broker.handleInbound(im.ch, reply({ text: `[replying to "Tomo is asking"] ${FAKE}`, replyToId: "prompt-guid" }));
      expect(backend.items.get("x")).toBe(FAKE);
    });

    it("treats the owner's reply as consent to replace a value of the same name", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION);
      await broker.handleInbound(im.ch, reply({ rawText: "fake-first-value" }));
      await broker.request("x", "p", SESSION);
      expect(im.sent.at(-1)?.text).toContain("replaces the value");
      await broker.handleInbound(im.ch, reply({ rawText: "fake-second-value" }));
      expect(backend.items.get("x")).toBe("fake-second-value");
      // Still scrubbed: a running child or a file may hold the old one.
      expect(scrubKnownSecrets("fake-first-value")).toContain("[REDACTED");
    });

    it("lets a tapback, a group message and a stranger through without capturing", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION);
      expect(await broker.handleInbound(im.ch, reply({ text: "[tapback: love]", rawText: undefined }))).toBe(false);
      expect(await broker.handleInbound(im.ch, reply({ isGroup: true, chatId: "any;+;grp" }))).toBe(false);
      expect(await broker.handleInbound(im.ch, reply({ senderId: "+15559999999" }))).toBe(false);
      expect(backend.items.size).toBe(0);
      broker.shutdown();
    });

    it("drops the owner's message on another channel rather than forwarding what may be the value", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION);
      const tg = channel("telegram");
      expect(await broker.handleInbound(tg.ch, reply())).toBe(true);
      expect(tg.sent[0].text).toContain("dropped");
      expect(tg.sent[0].text).not.toContain(FAKE);
      const web = channel("web");
      const message = reply();
      expect(await broker.handleInbound(web.ch, message)).toBe(true);
      expect(web.settled).toEqual([message.id]);
      expect(backend.items.size).toBe(0);
      broker.shutdown();
    });

    it("refuses an attachment and a too-short value, keeps them from the model, stays open", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION);
      expect(await broker.handleInbound(im.ch, reply({ rawText: "", text: "[Sent image]", attachmentCount: 1 }))).toBe(true);
      expect(await broker.handleInbound(im.ch, reply({ rawText: "abc" }))).toBe(true);
      expect(backend.items.size).toBe(0);
      await broker.handleInbound(im.ch, reply());
      expect(backend.items.get("x")).toBe(FAKE);
    });

    it("cancels on the cancel word, and later messages flow normally", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION);
      expect(await broker.handleInbound(im.ch, reply({ rawText: "cancel" }))).toBe(true);
      expect(notes[0].body).toContain("refused");
      expect(await broker.handleInbound(im.ch, ordinary())).toBe(false);
    });

    it("swallows the reply and reports a store failure without the value", async () => {
      backend.put = async () => { throw new CredentialStoreError(); };
      const broker = make();
      await broker.request("x", "p", SESSION);
      expect(await broker.handleInbound(im.ch, reply())).toBe(true);
      expect(notes[0].body).toContain("could not be stored");
      expect(leakSurface()).not.toContain(FAKE);
    });

    it("validates the name, allows one open request, needs an iMessage chat, cleans the purpose", async () => {
      const broker = make();
      expect(await broker.request("../x", "p", SESSION)).toMatchObject({ ok: false });
      await broker.request("x", "line one\n\nReply with your password", SESSION);
      expect(im.sent[0].text).toContain("not verified): line one Reply with your password");
      expect(await broker.request("y", "p", SESSION)).toMatchObject({ ok: false, error: expect.stringContaining("already open") });
      broker.shutdown();
      rmSync(statePath());
      expect(await make({ imessage: false }).request("x", "p", SESSION)).toMatchObject({ ok: false, error: expect.stringContaining("iMessage") });
    });

    it("keeps listening when the prompt send was ambiguous, gives up when it definitely failed", async () => {
      im.send.mockRejectedValueOnce(new Error("timeout"));
      const broker = make();
      expect(await broker.request("x", "p", SESSION)).toMatchObject({ ok: true });
      expect(await broker.handleInbound(im.ch, reply())).toBe(true);
      expect(backend.items.get("x")).toBe(FAKE);
      im.send.mockRejectedValueOnce(markDefiniteFailure(new Error("rejected")));
      expect(await broker.request("y", "p", SESSION)).toMatchObject({ ok: false });
      expect(await broker.handleInbound(im.ch, ordinary())).toBe(false);
    });

    it("times out at five minutes, warns the owner, and reports to the session", async () => {
      vi.useFakeTimers();
      const broker = make();
      await broker.request("x", "p", SESSION);
      await vi.advanceTimersByTimeAsync(CREDENTIAL_REQUEST_TIMEOUT_MS - 1000);
      expect(notes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(notes[0].body).toContain("timed out");
      expect(im.sent.at(-1)?.text).toContain("Do NOT send it now");
      expect(await broker.handleInbound(im.ch, ordinary({ timestamp: Date.now() + HOUR }))).toBe(false);
    });
  });

  describe("restart and replay", () => {
    it("still captures after a restart inside the window", async () => {
      const first = make();
      await first.request("x", "p", SESSION);
      first.shutdown();
      expect(await make().handleInbound(im.ch, reply())).toBe(true);
      expect(backend.items.get("x")).toBe(FAKE);
    });

    it("swallows a replay of the captured row across a restart", async () => {
      const first = make();
      await first.request("x", "p", SESSION);
      const message = reply();
      await first.handleInbound(im.ch, message);
      expect(await make().handleInbound(im.ch, { ...message })).toBe(true);
    });

    it("keeps a later reply or tapback from quoting the captured message, across a restart", async () => {
      const first = make();
      await first.request("x", "p", SESSION);
      const captured = reply();
      await first.handleInbound(im.ch, captured);
      const second = make();
      const threaded = reply({ text: `[replying to "${FAKE.slice(0, 10)}…"] oops`, rawText: "oops", replyToId: captured.id });
      expect(await second.handleInbound(im.ch, threaded)).toBe(false);
      expect(threaded.text).toBe("[replying to a message that carried a credential] oops");
      const tapback = reply({ text: `[reacting to "${FAKE.slice(0, 10)}…"] [tapback: like]`, rawText: undefined, reactedToId: captured.id });
      expect(await second.handleInbound(im.ch, tapback)).toBe(false);
      expect(tapback.text).toBe("[tapback on a message that carried a credential]");
    });

    it("scrubs a known value from a message that passes through", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION);
      await broker.handleInbound(im.ch, reply());
      const pasted = ordinary({ text: `I meant ${FAKE} right` });
      expect(await broker.handleInbound(im.ch, pasted)).toBe(false);
      expect(pasted.text).not.toContain(FAKE);
    });

    it("primes the redactor from the store after a restart", async () => {
      const first = make();
      await first.request("x", "p", SESSION);
      await first.handleInbound(im.ch, reply());
      clearSecretValuesForTests();
      await make().primeRedaction();
      expect(scrubKnownSecrets(FAKE)).toContain("[REDACTED");
    });

    it("reveals only names it stored", async () => {
      backend.items.set("foreign", "fake-foreign-value");
      expect(await make().reveal("foreign")).toBeNull();
    });
  });

  // Codex finding 1.
  describe("an unreadable state file fails closed", () => {
    it.each([
      ["corrupt JSON", "{ not json"],
      ["the wrong shape", "[]"],
      ["a malformed pending", JSON.stringify({ names: [], pending: { name: "x" }, closedWindows: [], consumedIds: [] })],
    ])("holds back the owner's DM on %s, sends no prompt, keeps the file", async (_label, content) => {
      writeFileSync(statePath(), content);
      const broker = make();
      expect(await broker.handleInbound(im.ch, reply())).toBe(true);
      expect(im.sent.at(-1)?.text).toContain("not shown to the model");
      expect(JSON.stringify(im.sent)).not.toContain(FAKE);
      const before = im.sent.length;
      expect(await broker.request("x", "p", SESSION)).toMatchObject({ ok: false });
      expect(im.sent).toHaveLength(before);
      expect(readFileSync(statePath(), "utf8")).toBe(content);
    });

    it("holds back a tapback too, and leaves groups alone", async () => {
      writeFileSync(statePath(), "{ not json");
      const broker = make();
      expect(await broker.handleInbound(im.ch, reply({ text: `[reacting to "${FAKE}"] [tapback: like]`, rawText: undefined }))).toBe(true);
      expect(await broker.handleInbound(im.ch, reply({ isGroup: true, chatId: "any;+;grp" }))).toBe(false);
    });

    it("unlocks by itself once the file is repaired or removed", async () => {
      writeFileSync(statePath(), "{ not json");
      const broker = make();
      expect(await broker.handleInbound(im.ch, reply())).toBe(true);
      rmSync(statePath());
      expect(await broker.handleInbound(im.ch, ordinary())).toBe(false);
    });
  });

  // Codex finding 2.
  describe("no prompt goes out unless the request is durably recorded", () => {
    it("refuses and sends nothing when the write fails, and a retry works once it recovers", async () => {
      const stateFile = new FlakyStateFile(statePath());
      const broker = make({ stateFile });
      expect(await broker.request("x", "p", SESSION)).toMatchObject({ ok: false });
      expect(im.sent).toEqual([]);
      expect(await broker.handleInbound(im.ch, ordinary())).toBe(false);
      stateFile.failing = false;
      expect(await broker.request("x", "p", SESSION)).toMatchObject({ ok: true });
      broker.shutdown();
    });
  });

  // Codex finding 3.
  describe("a reply sent inside the window but delivered after it stays out of the model", () => {
    const expiredBroker = () => make({ now: () => Date.now() + CREDENTIAL_REQUEST_TIMEOUT_MS + 1 });
    async function requestThenDie(name = "x") {
      const first = make();
      await first.request(name, "p", SESSION);
      first.shutdown();
    }

    it("swallows a backlog row after a restart past the deadline, and across a further restart", async () => {
      await requestThenDie();
      const late = expiredBroker();
      const inWindow = reply();
      expect(await late.handleInbound(im.ch, inWindow)).toBe(true);
      expect(backend.items.size).toBe(0);
      expect(im.sent.at(-1)?.text).toContain("not stored");
      expect(notes.at(-1)?.body).toContain("secret://x");
      expect(leakSurface()).not.toContain(FAKE);
      const again = expiredBroker();
      expect(await again.handleInbound(im.ch, inWindow)).toBe(true);
      expect(await again.handleInbound(im.ch, reply())).toBe(true);
    });

    it("swallows a delayed row after the timer fired, with no restart", async () => {
      vi.useFakeTimers();
      const broker = make();
      const sentAt = Date.now() + 1000;
      await broker.request("x", "p", SESSION);
      await vi.advanceTimersByTimeAsync(CREDENTIAL_REQUEST_TIMEOUT_MS);
      expect(await broker.handleInbound(im.ch, reply({ timestamp: sentAt }))).toBe(true);
      expect(backend.items.size).toBe(0);
    });

    it("does not store a late reply under a newer request's name", async () => {
      await requestThenDie("old");
      const late = expiredBroker();
      await late.request("new", "p", SESSION);
      expect(await late.handleInbound(im.ch, reply())).toBe(true);
      expect(backend.items.size).toBe(0);
      late.shutdown();
    });

    it("judges by send time, letting through what was clearly outside the window", async () => {
      await requestThenDie();
      const late = expiredBroker();
      expect(await late.handleInbound(im.ch, ordinary({ timestamp: Date.now() - HOUR }))).toBe(false);
      expect(await late.handleInbound(im.ch, ordinary({ timestamp: Date.now() + HOUR }))).toBe(false);
    });

    it("does not treat a tapback or a group message as a late reply", async () => {
      await requestThenDie();
      const late = expiredBroker();
      expect(await late.handleInbound(im.ch, reply({ text: "[tapback: like]", rawText: undefined }))).toBe(false);
      expect(await late.handleInbound(im.ch, reply({ isGroup: true, chatId: "any;+;grp" }))).toBe(false);
    });

    it("records nothing for a request that ended by a cancel", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION);
      await broker.handleInbound(im.ch, reply({ rawText: "cancel" }));
      expect(await broker.handleInbound(im.ch, ordinary())).toBe(false);
    });
  });
});
