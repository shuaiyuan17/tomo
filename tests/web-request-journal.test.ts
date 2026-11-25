import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebChannel } from "../src/channels/web.js";
import { WatchBus } from "../src/watch/bus.js";
import { WebRequestJournal } from "../src/web/request-journal.js";
import type { OwnerConfig } from "../src/owner.js";

const owner: OwnerConfig = { name: "owner", telegram: ["test-owner"], imessage: [] };
let root: string;
let path: string;
const channels: WebChannel[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tomo-web-journal-")); path = join(root, "data", "web", "requests.jsonl"); });
afterEach(async () => { for (const channel of channels.splice(0)) await channel.stop(); rmSync(root, { recursive: true, force: true }); });

/** A daemon run: a channel over the journal at `path`. A new call is the next run. */
function run(handler = vi.fn(async () => true), journal = new WebRequestJournal(path)) {
  const bus = new WatchBus();
  const channel = new WebChannel(owner, bus, { journal });
  channel.onMessage(handler);
  channels.push(channel);
  return { channel, bus, handler };
}
const records = () => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

describe("web request journal", () => {
  it("is on disk (0600) before the Agent is handed the message", async () => {
    let seenAtHandoff: unknown[] = [];
    const { channel } = run(vi.fn(async () => { seenAtHandoff = records(); return true; }));
    const requestId = randomUUID();
    await channel.receive({ requestId, text: "Book the table" });
    expect(seenAtHandoff).toEqual([expect.objectContaining({ op: "recv", id: requestId, text: "Book the table" })]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("after a hard crash: marks the unsettled request interrupted, never re-runs it, dedups the resend", async () => {
    const first = run();
    const requestId = randomUUID();
    await first.channel.receive({ requestId, text: "Send the invoice" });
    // No stop(), no terminal record: the process died here.
    const next = run();
    expect(next.channel.interruptedAtStart).toEqual([expect.objectContaining({ requestId, text: "Send the invoice" })]);
    expect(next.channel.request(requestId)).toMatchObject({ state: "interrupted", text: "Send the invoice" });
    expect(next.channel.snapshot().requests).toEqual([expect.objectContaining({ requestId, state: "interrupted" })]);
    // The browser retrying the same request id gets the outcome, not a second run.
    await expect(next.channel.receive({ requestId, text: "Send the invoice" })).resolves.toMatchObject({ state: "interrupted" });
    await expect(next.channel.receive({ requestId, text: "something else" })).rejects.toMatchObject({ status: 409 });
    expect(next.handler).not.toHaveBeenCalled();
    // A third run still knows it, and does not report it again.
    const third = run();
    expect(third.channel.interruptedAtStart).toEqual([]);
    expect(third.channel.request(requestId).state).toBe("interrupted");
  });

  it("keeps settled outcomes across restarts and drops their text", async () => {
    const first = run();
    const requestId = randomUUID();
    await first.channel.receive({ requestId, text: "Private words" });
    first.bus.publish({ type: "turn.end", sessionKey: "dm:owner", requestId, source: "user", ok: true, durationMs: 1 });
    const next = run();
    expect(next.channel.interruptedAtStart).toEqual([]);
    expect(next.channel.request(requestId)).toEqual(expect.objectContaining({ state: "completed" }));
    expect(next.channel.request(requestId).text).toBeUndefined();
    expect(readFileSync(path, "utf8")).not.toContain("Private words");
  });

  it("refuses custody when the record cannot be written", async () => {
    const journal = new WebRequestJournal(path);
    const { channel, handler } = run(undefined, journal);
    vi.spyOn(journal, "recordReceived").mockImplementation(() => { throw new Error("disk full"); });
    await expect(channel.receive({ requestId: randomUUID(), text: "hello" })).rejects.toMatchObject({ status: 503, code: "persist_failed" });
    expect(handler).not.toHaveBeenCalled();
    expect(channel.snapshot().requests).toEqual([]);
  });

  it("skips a torn last line", async () => {
    const first = run();
    const requestId = randomUUID();
    await first.channel.receive({ requestId, text: "kept" });
    appendFileSync(path, '{"op":"recv","id":"torn');
    expect(run().channel.interruptedAtStart.map((e) => e.requestId)).toEqual([requestId]);
  });

  it("is bounded: compacts and keeps the newest settled requests", async () => {
    const first = run(undefined, new WebRequestJournal(path, { maxReceipts: 10, compactEvery: 5 }));
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const requestId = randomUUID(); ids.push(requestId);
      await first.channel.receive({ requestId, text: `${i}` });
      first.bus.publish({ type: "turn.end", sessionKey: "dm:owner", requestId, source: "user", ok: true, durationMs: 1 });
    }
    expect(records().filter((r) => r.op === "recv").length).toBeLessThanOrEqual(10 + 5);
    const next = run(undefined, new WebRequestJournal(path, { maxReceipts: 10 }));
    expect(next.channel.request(ids.at(-1)!).state).toBe("completed");
    expect(next.channel.request(ids[0]).state).toBe("unknown"); // evicted: no longer known
  });
});

describe("interrupted requests awaiting the owner", () => {
  async function crashWith(count: number, text = (i: number) => `message ${i}`) {
    const first = run();
    const ids: string[] = [];
    for (let i = 0; i < count; i++) { const requestId = randomUUID(); ids.push(requestId); await first.channel.receive({ requestId, text: text(i) }); }
    return ids;
  }

  it("keeps the FULL text of every interrupted request across restarts and compaction, until resolved", async () => {
    const long = (i: number) => `${i}:${"z".repeat(15_000)}`;
    const ids = await crashWith(6, long);
    // Two more restarts, one with heavy compaction pressure on resolved entries.
    run();
    const journal = new WebRequestJournal(path, { maxReceipts: 3, compactEvery: 1 });
    const next = run(undefined, journal);
    for (const [i, id] of ids.entries()) expect(next.channel.request(id)).toMatchObject({ state: "interrupted", text: long(i) });
    expect(next.channel.snapshot().requests.filter((r) => r.state === "interrupted").map((r) => r.requestId)).toEqual(ids);
    // Resolved ones lose their text and may then be evicted; the rest stay whole.
    next.channel.resolveInterrupted(ids[0], "dismissed");
    next.channel.markRecorded([ids[1]]);
    const after = run(undefined, new WebRequestJournal(path, { maxReceipts: 3 }));
    expect(after.channel.request(ids[0]).text).toBeUndefined();
    expect(after.channel.request(ids[1]).text).toBeUndefined();
    for (const [i, id] of ids.entries()) if (i > 1) expect(after.channel.request(id).text).toBe(long(i));
    expect(readFileSync(path, "utf8")).not.toContain(long(0));
  });

  it("refuses new messages with a named reason once the backlog is full, and accepts again after dismissing", async () => {
    const ids = await crashWith(32);
    const second = run();
    for (let i = 0; i < 32; i++) await second.channel.receive({ requestId: randomUUID(), text: `again ${i}` });
    const third = run();
    expect(third.channel.interruptedAwaiting()).toHaveLength(64);
    await expect(third.channel.receive({ requestId: randomUUID(), text: "new" })).rejects.toMatchObject({ status: 503, code: "interrupted_backlog" });
    expect(third.handler).not.toHaveBeenCalled();
    third.channel.resolveInterrupted(ids[0], "dismissed");
    await expect(third.channel.receive({ requestId: randomUUID(), text: "new" })).resolves.toMatchObject({ state: "queued" });
  });
});

describe("unreadable journal", () => {
  it("refuses custody (503 journal_unavailable) when the journal cannot be read, and never writes it", async () => {
    const dirAsFile = join(root, "is-a-directory");
    mkdirSync(dirAsFile);
    const { channel, handler } = run(undefined, new WebRequestJournal(dirAsFile));
    await expect(channel.receive({ requestId: randomUUID(), text: "hello" })).rejects.toMatchObject({ status: 503, code: "journal_unavailable" });
    expect(handler).not.toHaveBeenCalled();
    // Nothing written in its place or beside it (no temp file, no compaction).
    expect(readdirSync(dirAsFile)).toEqual([]);
    expect(readdirSync(root)).toEqual(["is-a-directory"]);
  });

  it("a corrupt record before the last line: refuse, and leave the file byte-for-byte as it was", async () => {
    const first = run();
    await first.channel.receive({ requestId: randomUUID(), text: "one" });
    await first.channel.receive({ requestId: randomUUID(), text: "two" });
    const lines = readFileSync(path, "utf8").split("\n");
    lines.splice(1, 0, "{not json");
    writeFileSync(path, lines.join("\n"));
    const before = readFileSync(path);
    const journal = new WebRequestJournal(path, { compactEvery: 1 });
    const next = run(undefined, journal);
    await expect(next.channel.receive({ requestId: randomUUID(), text: "three" })).rejects.toMatchObject({ code: "journal_unavailable" });
    expect(() => journal.recordReceived(randomUUID(), "d", "x", 0)).toThrow(/before a successful load/);
    journal.recordState(randomUUID(), "completed");
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe("owner notice for interrupted requests", () => {
  it("is given once, and given again after a crash between persisting interrupted and recording the notice", async () => {
    const first = run();
    const requestId = randomUUID();
    await first.channel.receive({ requestId, text: "Pay the rent" });
    // Restart 1 marks it interrupted, then dies before the notice is recorded.
    const crashed = run();
    expect(crashed.channel.unnotifiedAtStart.map((e) => e.requestId)).toEqual([requestId]);
    // Restart 2 still owes the notice; it gives it and records that.
    const second = run();
    const notes: string[][] = [];
    second.channel.announceInterrupted((items) => { notes.push(items.map((e) => e.requestId)); return true; });
    expect(notes).toEqual([[requestId]]);
    second.channel.announceInterrupted((items) => { notes.push(items.map((e) => e.requestId)); return true; });
    expect(notes).toHaveLength(1);
    // Restart 3: already told.
    const third = run();
    third.channel.announceInterrupted((items) => { notes.push(items.map((e) => e.requestId)); return true; });
    expect(notes).toHaveLength(1);
    expect(third.channel.request(requestId)).toMatchObject({ state: "interrupted", text: "Pay the rent" });
    // And it stays told through further compactions.
    run(); run().channel.announceInterrupted((items) => { notes.push(items.map((e) => e.requestId)); return true; });
    expect(notes).toHaveLength(1);
  });

  it("a notice that could not be written to disk is not recorded as given, and the next start sends it", async () => {
    const first = run();
    const requestId = randomUUID();
    await first.channel.receive({ requestId, text: "Renew the passport" });
    const failing = run();
    failing.channel.announceInterrupted(() => false); // pending-notes write failed
    const next = run();
    const notes: string[][] = [];
    next.channel.announceInterrupted((items) => { notes.push(items.map((e) => e.requestId)); return true; });
    expect(notes).toEqual([[requestId]]);
  });
  it("a notice that throws is not recorded as given", async () => {
    const first = run();
    await first.channel.receive({ requestId: randomUUID(), text: "x" });
    const second = run();
    expect(() => second.channel.announceInterrupted(() => { throw new Error("pending notes store down"); })).toThrow();
    expect(run().channel.unnotifiedAtStart).toHaveLength(1);
  });
});

describe("snapshot", () => {
  it("always carries every interrupted request awaiting the owner, past the 128-request window", async () => {
    const ids: string[] = [];
    const first = run();
    for (let i = 0; i < 30; i++) { const requestId = randomUUID(); ids.push(requestId); await first.channel.receive({ requestId, text: `lost ${i}` }); }
    const next = run();
    for (let i = 0; i < 200; i++) {
      const requestId = randomUUID();
      await next.channel.receive({ requestId, text: `fine ${i}` });
      next.bus.publish({ type: "turn.end", sessionKey: "dm:owner", requestId, source: "user", ok: true, durationMs: 1 });
    }
    const shown = new Set(next.channel.snapshot().requests.map((r) => r.requestId));
    expect(ids.every((id) => shown.has(id))).toBe(true);
    expect(shown.size).toBeLessThanOrEqual(128 + 30);
  });
});
