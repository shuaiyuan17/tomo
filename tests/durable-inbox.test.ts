import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  ATTACHMENT_NOT_RESTORED,
  DurableInbox,
  persistableMessage,
  restoreMessage,
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
    const res = first.accept("imessage", msg("a"), resolution);
    if (res.status !== "accepted") throw new Error("expected accepted");
    first.markStarted([res.id]);
    first.markDone([res.id]);

    expect(reopen().pending()).toEqual([]);
  });

  it("a message whose turn started is reported as started, never as received", () => {
    const first = reopen();
    const res = first.accept("telegram", msg("7"), resolution);
    if (res.status !== "accepted") throw new Error("expected accepted");
    first.markStarted([res.id]);

    const next = reopen();
    const [rec] = next.pending();
    expect(rec.status).toBe("started");
    expect(rec.startedAt).toEqual(expect.any(Number));
    expect(next.isPending(rec.id)).toBe(false);
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
    const res = first.accept("imessage", msg("a"), resolution);
    if (res.status !== "accepted") throw new Error("expected accepted");
    first.markDone([res.id]);

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
    const res = first.accept("imessage", msg("a"), resolution);
    if (res.status !== "accepted") throw new Error("expected accepted");
    first.markDone([res.id]);

    t = 2_000;
    expect(reopen({ now: () => t, dedupRetentionMs: 500 }).accept("imessage", msg("a"), resolution).status).toBe("accepted");
  });

  it("caps remembered ids, keeping the newest", () => {
    const first = reopen({ maxSeen: 2 });
    for (const id of ["a", "b", "c"]) {
      const res = first.accept("imessage", msg(id), resolution);
      if (res.status !== "accepted") throw new Error("expected accepted");
      first.markDone([res.id]);
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
    expect(inbox.accept("imessage", msg("a"), resolution)).toEqual({ status: "unpersisted" });
  });

  it("a read-only instance neither compacts nor writes", () => {
    const owner = reopen();
    owner.accept("imessage", msg("a"), resolution);
    const before = readFileSync(path, "utf8");
    appendFileSync(path, "torn");
    const reader = new DurableInbox({ path, readOnly: true });
    expect(reader.pending().map((r) => r.message.id)).toEqual(["a"]);
    expect(reader.accept("imessage", msg("b"), resolution)).toEqual({ status: "unpersisted" });
    expect(readFileSync(path, "utf8")).toBe(`${before}torn`);
    expect(readdirSync(join(dir, "data")).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  it("refuses new writes once closed", () => {
    const inbox = reopen();
    inbox.close();
    expect(inbox.accept("imessage", msg("a"), resolution)).toEqual({ status: "unpersisted" });
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
