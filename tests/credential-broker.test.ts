import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { CREDENTIAL_REQUEST_TIMEOUT_MS, CredentialBroker, type CaptureChannel, type CredentialOrigin, type CredentialRequestView } from "../src/credentials/broker.js";
import { chatCaptureChannel, webCaptureChannel } from "../src/credentials/capture.js";
import { clearSecretValuesForTests, scrubKnownSecrets } from "../src/credentials/redactor.js";
import { BrokerStateFile, CredentialStoreError, MemoryBackend } from "../src/credentials/store.js";
import { markDefiniteFailure, type Channel, type IncomingMessage, type OutgoingMessage } from "../src/channels/types.js";
import { log } from "../src/logger.js";

const FAKE = "fake-owner-credential-9f3a";
const OWNER = "+15555550123";
const SESSION = "dm:owner";
const TG_OWNER = "1001";
const HOUR = 60 * 60_000;

function channel(name = "imessage", opts: { deletable?: boolean } = {}) {
  const sent: OutgoingMessage[] = [];
  const forgotten: string[] = [];
  const settled: string[] = [];
  const deleted: string[] = [];
  const ch = {
    name,
    send: vi.fn(async (m: OutgoingMessage) => { sent.push(m); }),
    forgetMessage: (_chat: string, id: string) => { forgotten.push(id); },
    settleMessage: (id: string) => { settled.push(id); },
    ...(opts.deletable ? { deleteInboundMessage: vi.fn(async (_chat: string, id: string) => { deleted.push(id); }) } : {}),
  } as unknown as Channel;
  return { ch, sent, forgotten, settled, deleted, send: ch.send as ReturnType<typeof vi.fn>,
    del: (ch as { deleteInboundMessage?: ReturnType<typeof vi.fn> }).deleteInboundMessage };
}

/** As the Agent builds them (src/credentials/capture.ts). */
const chatCapture = (c: ReturnType<typeof channel>, chatId: string): CaptureChannel => chatCaptureChannel(c.ch, chatId);
const webCapture = (cards: Array<CredentialRequestView | null>): CaptureChannel => webCaptureChannel({ publishCredentialRequest: (v) => { cards.push(v); } });
const IM: CredentialOrigin = { channelName: "imessage", chatId: OWNER };
const TG: CredentialOrigin = { channelName: "telegram", chatId: "1001" };
const WEB: CredentialOrigin = { channelName: "web", chatId: "owner" };

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
  let tg: ReturnType<typeof channel>;
  let cards: Array<CredentialRequestView | null>;
  let notes: Array<{ sessionKey: string; body: string }>;
  const statePath = () => join(dir, "state.json");

  function make(opts: { now?: () => number; imessage?: boolean; stateFile?: BrokerStateFile } = {}) {
    return new CredentialBroker({
      backend,
      stateFile: opts.stateFile ?? new BrokerStateFile(statePath()),
      isOwnerSender: (_channel, sender) => sender === OWNER || sender === TG_OWNER,
      captureChannel: (origin) => origin.channelName === "imessage" ? (opts.imessage === false ? null : chatCapture(im, origin.chatId))
        : origin.channelName === "telegram" ? chatCapture(tg, origin.chatId)
          : origin.channelName === "web" ? webCapture(cards) : null,
      notifySession: (sessionKey, body) => notes.push({ sessionKey, body }),
      ...(opts.now ? { now: opts.now } : {}),
    });
  }

  function leakSurface(): string {
    const logged = Object.values(log).flatMap((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls);
    const state = existsSync(statePath()) ? readFileSync(statePath(), "utf8") : "";
    return JSON.stringify([notes, im.sent, tg.sent, cards, logged, state]);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tomo-broker-"));
    backend = new MemoryBackend();
    im = channel();
    tg = channel("telegram", { deletable: true });
    cards = [];
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
      expect(await broker.request("github", "push to my repo", SESSION, IM)).toMatchObject({ ok: true, ref: "secret://github" });
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
      await broker.request("x", "p", SESSION, IM);
      await broker.handleInbound(im.ch, reply({ text: `[replying to "Tomo is asking"] ${FAKE}`, replyToId: "prompt-guid" }));
      expect(backend.items.get("x")).toBe(FAKE);
    });

    it("treats the owner's reply as consent to replace a value of the same name", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION, IM);
      await broker.handleInbound(im.ch, reply({ rawText: "fake-first-value" }));
      await broker.request("x", "p", SESSION, IM);
      expect(im.sent.at(-1)?.text).toContain("replaces the value");
      await broker.handleInbound(im.ch, reply({ rawText: "fake-second-value" }));
      expect(backend.items.get("x")).toBe("fake-second-value");
      // Still scrubbed: a running child or a file may hold the old one.
      expect(scrubKnownSecrets("fake-first-value")).toContain("[REDACTED");
    });

    it("lets a tapback, a group message and a stranger through without capturing", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION, IM);
      expect(await broker.handleInbound(im.ch, reply({ text: "[tapback: love]", rawText: undefined }))).toBe(false);
      expect(await broker.handleInbound(im.ch, reply({ isGroup: true, chatId: "any;+;grp" }))).toBe(false);
      expect(await broker.handleInbound(im.ch, reply({ senderId: "+15559999999" }))).toBe(false);
      expect(backend.items.size).toBe(0);
      broker.shutdown();
    });

    it("drops the owner's message on another chat channel rather than forwarding what may be the value, and deletes it on Telegram", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION, IM);
      const message = reply({ chatId: TG.chatId, senderId: TG_OWNER });
      expect(await broker.handleInbound(tg.ch, message)).toBe(true);
      expect(tg.deleted).toEqual([message.id]);
      expect(tg.sent[0].text).toContain("dropped");
      expect(tg.sent[0].text).toContain("deleted from this chat");
      expect(tg.sent[0].text).not.toContain(FAKE);
      expect(backend.items.size).toBe(0);
      broker.shutdown();
    });

    it("leaves the web UI's chat alone while a request is open: a value never arrives there", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION, IM);
      const web = channel("web");
      const message = reply({ chatId: "owner", rawText: "how is it going", text: "how is it going" });
      expect(await broker.handleInbound(web.ch, message)).toBe(false);
      expect(web.settled).toEqual([]);
      expect(web.sent).toEqual([]);
      // And the iMessage request is still open.
      expect(await broker.handleInbound(im.ch, reply())).toBe(true);
      expect(backend.items.get("x")).toBe(FAKE);
    });

    it("refuses an attachment and a too-short value, keeps them from the model, stays open", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION, IM);
      expect(await broker.handleInbound(im.ch, reply({ rawText: "", text: "[Sent image]", attachmentCount: 1 }))).toBe(true);
      expect(await broker.handleInbound(im.ch, reply({ rawText: "abc" }))).toBe(true);
      expect(backend.items.size).toBe(0);
      await broker.handleInbound(im.ch, reply());
      expect(backend.items.get("x")).toBe(FAKE);
    });

    it("cancels on the cancel word, and later messages flow normally", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION, IM);
      expect(await broker.handleInbound(im.ch, reply({ rawText: "cancel" }))).toBe(true);
      expect(notes[0].body).toContain("refused");
      expect(await broker.handleInbound(im.ch, ordinary())).toBe(false);
    });

    it("swallows the reply and reports a store failure without the value", async () => {
      backend.put = async () => { throw new CredentialStoreError(); };
      const broker = make();
      await broker.request("x", "p", SESSION, IM);
      expect(await broker.handleInbound(im.ch, reply())).toBe(true);
      expect(notes[0].body).toContain("could not be stored");
      expect(leakSurface()).not.toContain(FAKE);
    });

    it("validates the name, allows one open request, needs an iMessage chat, cleans the purpose", async () => {
      const broker = make();
      expect(await broker.request("../x", "p", SESSION, IM)).toMatchObject({ ok: false });
      await broker.request("x", "line one\n\nReply with your password", SESSION, IM);
      expect(im.sent[0].text).toContain("not verified): line one Reply with your password");
      expect(await broker.request("y", "p", SESSION, IM)).toMatchObject({ ok: false, error: expect.stringContaining("already open") });
      broker.shutdown();
      rmSync(statePath());
      expect(await make({ imessage: false }).request("x", "p", SESSION, IM)).toMatchObject({ ok: false, error: expect.stringContaining("cannot be asked on imessage") });
      expect(await make().request("x", "p", SESSION, { channelName: "slack", chatId: "c" })).toMatchObject({ ok: false });
    });

    it("keeps listening when the prompt send was ambiguous, gives up when it definitely failed", async () => {
      im.send.mockRejectedValueOnce(new Error("timeout"));
      const broker = make();
      expect(await broker.request("x", "p", SESSION, IM)).toMatchObject({ ok: true });
      expect(await broker.handleInbound(im.ch, reply())).toBe(true);
      expect(backend.items.get("x")).toBe(FAKE);
      im.send.mockRejectedValueOnce(markDefiniteFailure(new Error("rejected")));
      expect(await broker.request("y", "p", SESSION, IM)).toMatchObject({ ok: false });
      expect(await broker.handleInbound(im.ch, ordinary())).toBe(false);
    });

    it("times out at five minutes, warns the owner, and reports to the session", async () => {
      vi.useFakeTimers();
      const broker = make();
      await broker.request("x", "p", SESSION, IM);
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
      await first.request("x", "p", SESSION, IM);
      first.shutdown();
      expect(await make().handleInbound(im.ch, reply())).toBe(true);
      expect(backend.items.get("x")).toBe(FAKE);
    });

    it("swallows a replay of the captured row across a restart", async () => {
      const first = make();
      await first.request("x", "p", SESSION, IM);
      const message = reply();
      await first.handleInbound(im.ch, message);
      expect(await make().handleInbound(im.ch, { ...message })).toBe(true);
    });

    it("keeps a later reply or tapback from quoting the captured message, across a restart", async () => {
      const first = make();
      await first.request("x", "p", SESSION, IM);
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
      await broker.request("x", "p", SESSION, IM);
      await broker.handleInbound(im.ch, reply());
      const pasted = ordinary({ text: `I meant ${FAKE} right` });
      expect(await broker.handleInbound(im.ch, pasted)).toBe(false);
      expect(pasted.text).not.toContain(FAKE);
    });

    it("primes the redactor from the store after a restart", async () => {
      const first = make();
      await first.request("x", "p", SESSION, IM);
      await first.handleInbound(im.ch, reply());
      clearSecretValuesForTests();
      await make().primeRedaction();
      expect(scrubKnownSecrets(FAKE)).toContain("[REDACTED");
    });

  });

  // Codex finding 1.
  describe("an unreadable state file fails closed", () => {
    it.each([
      ["corrupt JSON", "{ not json"],
      ["a malformed pending", JSON.stringify({ names: [], pending: { name: "x" }, closedWindows: [], consumedIds: [] })],
    ])("holds back the owner's DM on %s, sends no prompt, keeps the file", async (_label, content) => {
      writeFileSync(statePath(), content);
      const broker = make();
      expect(await broker.handleInbound(im.ch, reply())).toBe(true);
      expect(im.sent.at(-1)?.text).toContain("not shown to the model");
      expect(JSON.stringify(im.sent)).not.toContain(FAKE);
      const before = im.sent.length;
      expect(await broker.request("x", "p", SESSION, IM)).toMatchObject({ ok: false });
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
      expect(await broker.request("x", "p", SESSION, IM)).toMatchObject({ ok: false });
      expect(im.sent).toEqual([]);
      expect(await broker.handleInbound(im.ch, ordinary())).toBe(false);
      stateFile.failing = false;
      expect(await broker.request("x", "p", SESSION, IM)).toMatchObject({ ok: true });
      broker.shutdown();
    });
  });

  // Codex finding 3.
  describe("a reply sent inside the window but delivered after it stays out of the model", () => {
    const expiredBroker = () => make({ now: () => Date.now() + CREDENTIAL_REQUEST_TIMEOUT_MS + 1 });
    async function requestThenDie(name = "x") {
      const first = make();
      await first.request(name, "p", SESSION, IM);
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
      await broker.request("x", "p", SESSION, IM);
      await vi.advanceTimersByTimeAsync(CREDENTIAL_REQUEST_TIMEOUT_MS);
      expect(await broker.handleInbound(im.ch, reply({ timestamp: sentAt }))).toBe(true);
      expect(backend.items.size).toBe(0);
    });

    it("does not store a late reply under a newer request's name", async () => {
      await requestThenDie("old");
      const late = expiredBroker();
      await late.request("new", "p", SESSION, IM);
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
      await broker.request("x", "p", SESSION, IM);
      await broker.handleInbound(im.ch, reply({ rawText: "cancel" }));
      expect(await broker.handleInbound(im.ch, ordinary())).toBe(false);
    });
  });

  describe("the channel this turn came in on", () => {
    it("refuses a turn nobody is typing in (cron, heartbeat, a batch across chats) and sends nothing", async () => {
      const broker = make();
      expect(await broker.request("x", "p", SESSION, null)).toMatchObject({ ok: false, error: expect.stringContaining("scheduled job") });
      expect([...im.sent, ...tg.sent, ...cards]).toEqual([]);
    });
  });

  describe("Telegram", () => {
    const tgReply = (overrides: Partial<IncomingMessage> = {}) => reply({ id: String(++seq), chatId: TG.chatId, senderId: TG_OWNER, ...overrides });

    it("asks in the owner's private chat, captures the next message, and deletes it from the chat", async () => {
      const broker = make();
      expect(await broker.request("github", "push", SESSION, TG)).toMatchObject({ ok: true, channel: "telegram" });
      expect(tg.sent[0]).toMatchObject({ chatId: TG.chatId, text: expect.stringContaining("deletes it from the chat") });
      expect(im.sent).toEqual([]);
      const message = tgReply();
      expect(await broker.handleInbound(tg.ch, message)).toBe(true);
      expect(backend.items.get("github")).toBe(FAKE);
      expect(tg.deleted).toEqual([message.id]);
      expect(tg.sent.at(-1)?.text).toContain("Your message was deleted from this chat");
      expect(notes.at(-1)?.body).toContain("security find-generic-password -s tomo-credential-broker -a github -w");
      expect(leakSurface()).not.toContain(FAKE);
    });

    it("tells the owner to delete it themselves when Telegram refuses the delete", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION, TG);
      tg.del!.mockRejectedValueOnce(new Error("Bad Request: message can't be deleted"));
      expect(await broker.handleInbound(tg.ch, tgReply())).toBe(true);
      expect(backend.items.get("x")).toBe(FAKE);
      expect(tg.sent.at(-1)?.text).toContain("could not delete your message, so delete it from this chat yourself");
    });

    it("passes through what is not the value: a reaction, a sticker, a group message, a stranger; and drops the owner's iMessage", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION, TG);
      expect(await broker.handleInbound(tg.ch, tgReply({ text: "[tapback: like]", rawText: undefined, isReaction: true }))).toBe(false);
      expect(await broker.handleInbound(tg.ch, tgReply({ text: "[sticker]", rawText: undefined }))).toBe(false);
      expect(await broker.handleInbound(tg.ch, tgReply({ isGroup: true, chatId: "-100200" }))).toBe(false);
      expect(await broker.handleInbound(tg.ch, tgReply({ senderId: "999" }))).toBe(false);
      expect(tg.deleted).toEqual([]);
      expect(await broker.handleInbound(im.ch, reply())).toBe(true);
      expect(im.sent.at(-1)?.text).toContain("waiting for x in Telegram");
      expect(backend.items.size).toBe(0);
      expect(await broker.handleInbound(tg.ch, tgReply())).toBe(true);
      expect(backend.items.get("x")).toBe(FAKE);
    });

    it("does not confuse a group's message id with a consumed private one", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION, TG);
      await broker.handleInbound(tg.ch, tgReply({ id: "42" }));
      expect(await broker.handleInbound(tg.ch, tgReply({ id: "42", isGroup: true, chatId: "-100200", rawText: "hi", text: "hi" }))).toBe(false);
      expect(await broker.handleInbound(tg.ch, tgReply({ id: "42" }))).toBe(true);
    });

    it("deletes an invalid value too, and keeps the request open", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION, TG);
      const short = tgReply({ rawText: "abc", text: "abc" });
      expect(await broker.handleInbound(tg.ch, short)).toBe(true);
      expect(tg.deleted).toEqual([short.id]);
      expect(await broker.handleInbound(tg.ch, tgReply({ rawText: "fake-non-ascii-é-value", text: "fake-non-ascii-é-value" }))).toBe(true);
      expect(backend.items.size).toBe(0);
      expect(await broker.handleInbound(tg.ch, tgReply())).toBe(true);
      expect(backend.items.get("x")).toBe(FAKE);
    });
  });

  describe("the web UI's card", () => {
    it("opens a card (no chat prompt), takes the value through fulfill, and withdraws the card", async () => {
      const broker = make();
      const opened = await broker.request("github", "line one\nline two", SESSION, WEB);
      expect(opened).toMatchObject({ ok: true, channel: "web" });
      expect(cards).toHaveLength(1);
      const view = cards[0]!;
      expect(view).toEqual({ id: expect.any(String), name: "github", purpose: "line one line two", expiresAt: expect.any(Number) });
      expect(broker.formRequest("web")).toEqual(view);
      expect([...im.sent, ...tg.sent]).toEqual([]);
      expect(await broker.fulfill(view.id, { value: `  ${FAKE}  ` })).toEqual({ ok: true, outcome: "stored" });
      expect(backend.items.get("github")).toBe(FAKE);
      expect(cards.at(-1)).toBeNull();
      expect(broker.formRequest("web")).toBeNull();
      expect(notes.at(-1)?.body).toContain("secret://github");
      expect(leakSurface()).not.toContain(FAKE);
    });

    it("refuses a wrong id (409), an expired request (410), and a bad value (400, still open)", async () => {
      let now = Date.now();
      const broker = make({ now: () => now });
      await broker.request("x", "p", SESSION, WEB);
      const { id } = cards[0]!;
      expect(await broker.fulfill("00000000-0000-4000-8000-000000000000", { value: FAKE })).toMatchObject({ ok: false, status: 409 });
      expect(await broker.fulfill(id, { value: "abc" })).toMatchObject({ ok: false, status: 400, code: "invalid_value" });
      expect(broker.formRequest("web")?.id).toBe(id);
      now += CREDENTIAL_REQUEST_TIMEOUT_MS + 1;
      expect(await broker.fulfill(id, { value: FAKE })).toMatchObject({ ok: false, status: 410, code: "credential_expired" });
      expect(await broker.fulfill(id, { value: FAKE })).toMatchObject({ ok: false, status: 410 });
      expect(notes.at(-1)?.body).toContain("timed out");
      expect(cards.at(-1)).toBeNull();
      expect(backend.items.size).toBe(0);
    });

    it("cancel refuses the request; a chat-channel request cannot be answered through the card", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION, WEB);
      expect(await broker.fulfill(cards[0]!.id, { cancel: true })).toEqual({ ok: true, outcome: "cancelled" });
      expect(notes.at(-1)?.body).toContain("refused");
      await broker.request("y", "p", SESSION, IM);
      expect(broker.formRequest("web")).toBeNull();
    });

    it("drops the owner's iMessage and Telegram messages while the card is open, but not the web chat", async () => {
      const broker = make();
      await broker.request("x", "p", SESSION, WEB);
      expect(await broker.handleInbound(im.ch, reply())).toBe(true);
      expect(im.sent.at(-1)?.text).toContain("the web UI's card");
      expect(await broker.handleInbound(tg.ch, reply({ id: "77", chatId: TG.chatId, senderId: TG_OWNER }))).toBe(true);
      expect(tg.deleted).toEqual(["77"]);
      expect(await broker.handleInbound(channel("web").ch, reply({ chatId: "owner" }))).toBe(false);
      expect(backend.items.size).toBe(0);
    });

    it("re-shows the card after a restart inside the window", async () => {
      const first = make();
      await first.request("x", "p", SESSION, WEB);
      first.shutdown();
      expect(make().formRequest("web")).toEqual(cards[0]);
    });
  });

  describe("an unreadable state file holds back only the channel it names", () => {
    const pendingOn = (channel: string) => JSON.stringify({ names: "broken", pending: { channel }, closedWindows: [], consumedIds: [] });

    it("holds only Telegram when the request recorded is on Telegram", async () => {
      writeFileSync(statePath(), pendingOn("telegram"));
      const broker = make();
      expect(await broker.handleInbound(im.ch, ordinary())).toBe(false);
      const held = reply({ id: "55", chatId: TG.chatId, senderId: TG_OWNER });
      expect(await broker.handleInbound(tg.ch, held)).toBe(true);
      expect(tg.deleted).toEqual(["55"]);
      expect(tg.sent.at(-1)?.text).toContain("held back");
    });

    it("holds no chat for a web request, and never the web chat", async () => {
      writeFileSync(statePath(), pendingOn("web"));
      const broker = make();
      expect(await broker.handleInbound(im.ch, ordinary())).toBe(false);
      expect(await broker.handleInbound(tg.ch, ordinary({ chatId: TG.chatId, senderId: TG_OWNER }))).toBe(false);
      expect(await broker.handleInbound(channel("web").ch, ordinary({ chatId: "owner" }))).toBe(false);
      expect(broker.formRequest("web")).toBeNull();
      expect(await broker.fulfill("00000000-0000-4000-8000-000000000000", { value: FAKE })).toMatchObject({ ok: false, status: 503 });
    });

    it("holds no chat when the file records no request", async () => {
      writeFileSync(statePath(), "[]");
      expect(await make().handleInbound(im.ch, ordinary())).toBe(false);
    });

    it("holds every chat channel (but not the web chat) when nothing can be read", async () => {
      writeFileSync(statePath(), "{ not json");
      const broker = make();
      expect(await broker.handleInbound(im.ch, ordinary())).toBe(true);
      expect(await broker.handleInbound(tg.ch, ordinary({ chatId: TG.chatId, senderId: TG_OWNER }))).toBe(true);
      expect(await broker.handleInbound(channel("web").ch, ordinary({ chatId: "owner" }))).toBe(false);
    });
  });
});
