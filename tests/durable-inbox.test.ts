import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Root-safe read and quarantine failures (chmod stops neither for root): a
// test names the path whose readFileSync throws EACCES, or whose
// appendFileSync throws ENOSPC.
const fail = vi.hoisted(() => ({ read: null as string | null, append: null as RegExp | null }));
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  return {
    ...orig,
    readFileSync: ((...args: Parameters<typeof orig.readFileSync>) => {
      if (fail.read !== null && args[0] === fail.read) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return orig.readFileSync(...args);
    }) as typeof orig.readFileSync,
    appendFileSync: ((...args: Parameters<typeof orig.appendFileSync>) => {
      if (fail.append !== null && fail.append.test(String(args[0]))) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return orig.appendFileSync(...args);
    }) as typeof orig.appendFileSync,
  };
});

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  ATTACHMENT_NOT_RESTORED,
  DurableInbox,
  persistableMessage,
  restoreMessage,
  type WriteFn,
} from "../src/agent/durable-inbox.js";
import type { IncomingMessage } from "../src/channels/types.js";
import type { SessionResolution } from "../src/router.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = join(tmpdir(), `tomo-inbox-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  path = join(dir, "data", "inbox.jsonl");
});

afterEach(() => {
  fail.read = null;
  fail.append = null;
  rmSync(dir, { recursive: true, force: true });
});

function msg(id: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return { id, chatId: "+15550001", senderName: "Owner", text: `text ${id}`, timestamp: 1_000, ...overrides };
}

const resolution: SessionResolution = {
  sessionKey: "dm:owner",
  replyTarget: { channelName: "imessage", chatId: "+15550001" },
  identityName: "owner",
};

/** A fresh instance over the same file — what the next daemon start sees. */
function reopen(opts: Partial<ConstructorParameters<typeof DurableInbox>[0]> = {}): DurableInbox {
  return new DurableInbox({ path, fsync: false, ...opts });
}

/** Accept `id` on iMessage, failing the test unless it was accepted; returns the record id. */
function acceptOk(inbox: DurableInbox, id: string, channel = "imessage"): string {
  const res = inbox.accept(channel, msg(id), resolution);
  if (res.status !== "accepted") throw new Error(`expected ${id} to be accepted, got ${res.status}`);
  return res.id;
}

describe("DurableInbox: crash and replay", () => {
  it("a message accepted and never consumed is pending after a crash", () => {
    const first = reopen();
    expect(first.accept("imessage", msg("a"), resolution).status).toBe("accepted");
    // No close(), no markDone: the process just dies.

    const next = reopen();
    const pending = next.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      channel: "imessage",
      status: "received",
      resolution,
      message: { id: "a", chatId: "+15550001", text: "text a" },
    });
  });

  it("a consumed message is not pending again", () => {
    const first = reopen();
    const id = acceptOk(first, "a");
    first.markStarted([id]);
    first.markDone([id]);

    expect(reopen().pending()).toEqual([]);
  });

  it("a message whose turn started is reported as started, never as received", () => {
    const first = reopen();
    first.markStarted([acceptOk(first, "7", "telegram")]);

    const next = reopen();
    const [rec] = next.pending();
    expect(rec.status).toBe("started");
    expect(rec.startedAt).toEqual(expect.any(Number));
    expect(next.isPending(rec.id)).toBe(false);
  });

  it("keeps a started record's self-restart mark across a restart and a compaction", () => {
    const first = reopen();
    const a = first.accept("imessage", msg("a"), resolution);
    const b = first.accept("imessage", msg("b"), resolution);
    if (a.status !== "accepted" || b.status !== "accepted") throw new Error("expected accepted");
    first.markStarted([a.id]);
    // Only a started record can have been cut short by its own turn's restart.
    first.markSelfRestart([a.id, b.id], "deploy");

    const next = reopen(); // load() compacts
    expect(next.pending().map((r) => [r.message.id, r.status, r.selfRestart])).toEqual([
      ["a", "started", { reason: "deploy" }],
      ["b", "received", undefined],
    ]);
    expect(reopen().pending()[0].selfRestart).toEqual({ reason: "deploy" });
  });

  it("returns pending records oldest first", () => {
    let t = 100;
    const first = reopen({ now: () => t });
    first.accept("imessage", msg("one"), resolution);
    t = 200;
    first.accept("imessage", msg("two"), resolution);
    t = 300;
    first.accept("telegram", msg("three"), resolution);

    expect(reopen().pending().map((r) => r.message.id)).toEqual(["one", "two", "three"]);
  });
});

describe("DurableInbox: dedup on (channel, chat, message id)", () => {
  it("refuses the same message twice while it is pending", () => {
    const inbox = reopen();
    expect(inbox.accept("imessage", msg("a"), resolution).status).toBe("accepted");
    expect(inbox.accept("imessage", msg("a"), resolution).status).toBe("duplicate");
    expect(inbox.pending()).toHaveLength(1);
  });

  it("remembers consumed ids across a restart (a channel redelivering an un-acked row)", () => {
    const first = reopen();
    first.markDone([acceptOk(first, "a")]);

    expect(reopen().accept("imessage", msg("a"), resolution).status).toBe("duplicate");
  });

  it("scopes ids by channel and chat: Telegram ids are only unique per chat", () => {
    const inbox = reopen();
    expect(inbox.accept("telegram", msg("42", { chatId: "1" }), resolution).status).toBe("accepted");
    expect(inbox.accept("telegram", msg("42", { chatId: "2" }), resolution).status).toBe("accepted");
    expect(inbox.accept("imessage", msg("42", { chatId: "1" }), resolution).status).toBe("accepted");
  });

  it("tells apart two hand-offs that share a provider id (attachment follow-ups)", () => {
    const inbox = reopen();
    expect(inbox.accept("imessage", msg("guid-1"), resolution).status).toBe("accepted");
    expect(inbox.accept("imessage", msg("guid-1", { inboxKey: "attachments:0" }), resolution).status).toBe("accepted");
    expect(inbox.accept("imessage", msg("guid-1", { inboxKey: "attachments:1,2" }), resolution).status).toBe("accepted");
    expect(inbox.accept("imessage", msg("guid-1", { inboxKey: "attachments:0" }), resolution).status).toBe("duplicate");
    // The key survives a restart, so the replayed follow-up keeps its identity.
    expect(reopen().pending().map((r) => r.message.inboxKey)).toEqual([undefined, "attachments:0", "attachments:1,2"]);
  });

  it("forgets consumed ids after the retention window", () => {
    let t = 1_000;
    const first = reopen({ now: () => t, dedupRetentionMs: 500 });
    first.markDone([acceptOk(first, "a")]);

    t = 2_000;
    expect(reopen({ now: () => t, dedupRetentionMs: 500 }).accept("imessage", msg("a"), resolution).status).toBe("accepted");
  });

  it("keeps a consumed id through the last instant of the retention window", () => {
    let t = 1_000;
    const first = reopen({ now: () => t, dedupRetentionMs: 500 });
    first.markDone([acceptOk(first, "a")]);

    // Exactly `retention` old: still remembered.
    t = 1_500;
    expect(reopen({ now: () => t, dedupRetentionMs: 500 }).accept("imessage", msg("a"), resolution).status).toBe("duplicate");
    // One millisecond past it: forgotten.
    t = 1_501;
    expect(reopen({ now: () => t, dedupRetentionMs: 500 }).accept("imessage", msg("a"), resolution).status).toBe("accepted");
  });

  it("keeps every id when exactly at the cap", () => {
    const first = reopen({ maxSeen: 3 });
    for (const id of ["a", "b", "c"]) first.markDone([acceptOk(first, id)]);
    const next = reopen({ maxSeen: 3 });
    for (const id of ["a", "b", "c"]) expect(next.has(DurableInbox.idFor("imessage", "+15550001", id)), id).toBe(true);
  });

  it("caps remembered ids, keeping the newest", () => {
    const first = reopen({ maxSeen: 2 });
    for (const id of ["a", "b", "c"]) {
      first.markDone([acceptOk(first, id)]);
    }
    const next = reopen({ maxSeen: 2 });
    expect(next.has(DurableInbox.idFor("imessage", "+15550001", "a"))).toBe(false);
    expect(next.has(DurableInbox.idFor("imessage", "+15550001", "c"))).toBe(true);
  });
});

describe("DurableInbox: retention and compaction", () => {
  it("compacts the log down to live state plus tombstones", () => {
    const inbox = reopen({ compactEvery: 4 });
    const ids: string[] = [];
    for (const id of ["a", "b", "c"]) {
      const res = inbox.accept("imessage", msg(id), resolution);
      if (res.status === "accepted") ids.push(res.id);
    }
    inbox.markStarted(ids.slice(0, 2));
    inbox.markDone(ids.slice(0, 2));

    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { op: string });
    // Two tombstones and the one record still waiting — no start/done history.
    expect(lines.map((l) => l.op).sort()).toEqual(["recv", "seen", "seen"]);
    expect(reopen().pending().map((r) => r.message.id)).toEqual(["c"]);
  });

  it("keeps a torn line from a crash mid-append instead of compacting it away", () => {
    const first = reopen();
    first.accept("imessage", msg("a"), resolution);
    appendFileSync(path, "{\"op\":\"recv\",\"v\":1,\"rec\":{\"id\":");

    const next = reopen();
    expect(next.pending().map((r) => r.message.id)).toEqual(["a"]);
    const corrupt = readdirSync(join(dir, "data")).filter((f) => f.startsWith("inbox.jsonl.corrupt-"));
    expect(corrupt).toHaveLength(1);
    expect(readFileSync(join(dir, "data", corrupt[0]), "utf8")).toContain("{\"op\":\"recv\",\"v\":1,\"rec\":{\"id\":");
  });

  it("does not create a file before anything is accepted", () => {
    reopen();
    expect(existsSync(path)).toBe(false);
  });

  it("reports a write it cannot make instead of pretending it persisted", () => {
    // A directory where the log should be: unreadable AND unwritable.
    mkdirSync(path, { recursive: true });
    const inbox = reopen();
    expect(inbox.accept("imessage", msg("a"), resolution)).toEqual({ status: "unpersisted", reason: "failed" });
  });

  it("a read-only instance neither compacts nor writes", () => {
    const owner = reopen();
    owner.accept("imessage", msg("a"), resolution);
    const before = readFileSync(path, "utf8");
    appendFileSync(path, "torn");
    const reader = new DurableInbox({ path, readOnly: true });
    expect(reader.pending().map((r) => r.message.id)).toEqual(["a"]);
    expect(reader.accept("imessage", msg("b"), resolution)).toEqual({ status: "unpersisted", reason: "closed" });
    expect(readFileSync(path, "utf8")).toBe(`${before}torn`);
    expect(readdirSync(join(dir, "data")).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  it("refuses new writes once closed", () => {
    const inbox = reopen();
    inbox.close();
    expect(inbox.accept("imessage", msg("a"), resolution)).toEqual({ status: "unpersisted", reason: "closed" });
  });
});

describe("DurableInbox: attachments", () => {
  it("never persists attachment bytes, only where to reload them", () => {
    const imgPath = join(dir, "img.jpg");
    writeFileSync(imgPath, Buffer.from("jpeg-bytes"));
    const inbox = reopen();
    inbox.accept("imessage", msg("a", {
      images: [{ data: Buffer.from("jpeg-bytes").toString("base64"), mediaType: "image/jpeg", savedPath: imgPath }],
    }), resolution);

    expect(readFileSync(path, "utf8")).not.toContain(Buffer.from("jpeg-bytes").toString("base64"));
    const [rec] = reopen().pending();
    const restored = restoreMessage(rec.message);
    expect(restored.images).toEqual([{ data: Buffer.from("jpeg-bytes").toString("base64"), mediaType: "image/jpeg", savedPath: imgPath }]);
    expect(restored.text).toBe("text a");
  });

  it("says so in the text when an attachment cannot be restored", () => {
    const persisted = persistableMessage(msg("a", {
      images: [{ data: "AAAA", mediaType: "image/png" }],
      documents: [{ data: "BBBB", mediaType: "application/pdf", savedPath: join(dir, "gone.pdf") }],
    }));
    const restored = restoreMessage(persisted);
    expect(restored.images).toBeUndefined();
    expect(restored.documents).toBeUndefined();
    expect(restored.text).toBe(`text a\n${ATTACHMENT_NOT_RESTORED}`);
  });
});

const realWrite: WriteFn = (fd, buf, off, len) => writeSync(fd, buf, off, len);

describe("DurableInbox: short writes", () => {
  it("an append that the kernel only half-writes is finished, not truncated", () => {
    // Every call writes at most half of what it is asked for.
    const halfWrite: WriteFn = (fd, buf, off, len) => realWrite(fd, buf, off, Math.max(1, Math.floor(len / 2)));
    const inbox = reopen({ writeSync: halfWrite });
    expect(inbox.accept("imessage", msg("half", { text: "x".repeat(500) }), resolution).status).toBe("accepted");
    expect(reopen().pending().map((r) => r.message.text)).toEqual(["x".repeat(500)]);
  });

  it("a write that makes no progress is a failure, not a success", () => {
    const inbox = reopen({ writeSync: () => 0 });
    expect(inbox.accept("imessage", msg("zero"), resolution)).toEqual({ status: "unpersisted", reason: "failed" });
  });

  it("a compaction whose temp file came out short keeps the original log", () => {
    let lie = false;
    // Reports the whole buffer written but writes only half of it.
    const lying: WriteFn = (fd, buf, off, len) => {
      if (!lie) return realWrite(fd, buf, off, len);
      realWrite(fd, buf, off, Math.floor(len / 2));
      return len;
    };
    const inbox = reopen({ writeSync: lying, compactEvery: 1 });
    inbox.accept("imessage", msg("keep1"), resolution);
    inbox.accept("imessage", msg("keep2"), resolution);
    const before = readFileSync(path, "utf8");
    lie = true;
    inbox.markDone([inbox.pending()[0].id]); // the `done` append is short too…
    lie = false;
    // …so the line torn by it is set apart on the next append, and the
    // compaction that followed it never replaced the log.
    expect(readFileSync(path, "utf8").startsWith(before)).toBe(true);
    expect(readdirSync(join(dir, "data")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(reopen().pending().map((r) => r.message.id)).toContain("keep2");
  });

  it("a compaction temp file of the wrong length is discarded and the log kept", () => {
    const first = reopen();
    acceptOk(first, "c1");
    acceptOk(first, "c2");
    first.close();
    const before = readFileSync(path, "utf8");
    // The start-up compaction is the one write that carries several records;
    // it comes out half as long as reported. Single-record appends are honest.
    let shortWrites = 0;
    const shortCompaction: WriteFn = (fd, buf, off, len) => {
      const text = Buffer.from(buf).subarray(off, off + len).toString("utf8");
      if ((text.match(/"op":/g) ?? []).length < 2) return realWrite(fd, buf, off, len);
      shortWrites++;
      realWrite(fd, buf, off, Math.floor(len / 2));
      return len;
    };
    const next = reopen({ writeSync: shortCompaction });
    expect(shortWrites).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(join(dir, "data")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(next.pending().map((r) => r.message.id)).toEqual(["c1", "c2"]);
    expect(reopen().pending().map((r) => r.message.id)).toEqual(["c1", "c2"]);
  });
});

describe("DurableInbox: a start that cannot be written", () => {
  it("retries, then rewrites the log with the start, so nothing is left replayable", () => {
    let startFails = 0;
    const failStart: WriteFn = (fd, buf, off, len) => {
      if (Buffer.from(buf).subarray(off, off + len).toString("utf8").replace(/^\n/, "").startsWith('{"op":"start"')) {
        startFails++;
        throw new Error("EIO");
      }
      return realWrite(fd, buf, off, len);
    };
    const inbox = reopen({ writeSync: failStart });
    const id = (inbox.accept("imessage", msg("s"), resolution) as { id: string }).id;
    expect(inbox.markStarted([id])).toEqual([]);
    expect(startFails).toBe(2);
    expect(reopen().pending()[0]).toMatchObject({ id, status: "started" });
  });

  it("when nothing can be written, marks it unreplayable and records it started once the disk is back", () => {
    let broken = false;
    const write: WriteFn = (fd, buf, off, len) => {
      if (broken) throw new Error("EIO");
      return realWrite(fd, buf, off, len);
    };
    const inbox = reopen({ writeSync: write, compactEvery: 1 });
    const id = (inbox.accept("imessage", msg("u"), resolution) as { id: string }).id;
    const other = (inbox.accept("imessage", msg("v"), resolution) as { id: string }).id;
    broken = true;
    expect(inbox.markStarted([id])).toEqual([id]);
    expect(inbox.get(id)).toMatchObject({ status: "started", unreplayable: true });
    expect(inbox.isPending(id)).toBe(false);

    broken = false;
    inbox.markDone([other]); // its compaction rewrites the log from memory
    expect(reopen().pending()).toEqual([expect.objectContaining({ id, status: "started" })]);
    expect(inbox.get(id)?.unreplayable).toBeUndefined();
  });
});

describe("DurableInbox: an unreadable log is not an empty one", () => {
  it("keeps appending but never compacts a log it could not read", () => {
    const first = reopen();
    acceptOk(first, "old");
    first.close();
    const before = readFileSync(path, "utf8");

    // EACCES/EIO on the read: the bytes are fine, just out of reach.
    fail.read = path;
    const blind = reopen({ compactEvery: 1 });
    fail.read = null;
    // Replay and dedup are off for this run...
    expect(blind.pending()).toEqual([]);
    // ...appends still land, after what was there...
    blind.markDone([acceptOk(blind, "new")]); // a markDone past compactEvery would compact
    const after = readFileSync(path, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);

    // ...so the next start that can read it still has the old record.
    expect(reopen().pending().map((r) => r.message.id)).toEqual(["old"]);
  });

  it("disables compaction when unreadable lines cannot be set aside", () => {
    const first = reopen();
    acceptOk(first, "a");
    first.close();
    appendFileSync(path, "{\"op\":\"recv\",\"v\":1,\"rec\":{\"id\":");
    const before = readFileSync(path, "utf8");

    // The `.corrupt-` copy cannot be written: rewriting the log now would
    // drop the torn line with nothing left to show for it.
    fail.append = /inbox\.jsonl\.corrupt-/;
    const next = reopen({ compactEvery: 1 });
    fail.append = null;
    expect(next.pending().map((r) => r.message.id)).toEqual(["a"]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(join(dir, "data")).some((f) => f.includes(".corrupt-"))).toBe(false);

    // Appends still work, and still do not compact.
    next.markDone([acceptOk(next, "b")]);
    expect(readFileSync(path, "utf8").startsWith(before)).toBe(true);
  });
});

describe("DurableInbox: leftovers", () => {
  it("removes a compaction temp file a crash left behind", () => {
    mkdirSync(join(dir, "data"), { recursive: true });
    const stale = `${path}.123.abc.tmp`;
    writeFileSync(stale, "partial");
    reopen();
    expect(existsSync(stale)).toBe(false);
  });
});
