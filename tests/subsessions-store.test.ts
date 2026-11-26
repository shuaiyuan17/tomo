import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTable, SubsessionStore, SubsessionStoreError } from "../src/agent/subsessions/store.js";
import { TRANSITION_LOG_KEEP, appendInput, HARNESS } from "../src/agent/subsessions/types.js";

let dir = "";
let path = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tomo-substore-"));
  path = join(dir, "data", "subsessions.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SubsessionStore", () => {
  it("hands out global ids s1, s2… and keys task:<id>, never reused", () => {
    const store = new SubsessionStore(path, { strictTransitions: true });
    const a = store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    const b = store.create({ parentKey: "telegram:-100", title: "c", brief: "d" });
    expect([a.id, a.sessionKey, b.id, b.sessionKey]).toEqual(["s1", "task:s1", "s2", "task:s2"]);
    store.remove([b.id]);
    expect(store.create({ parentKey: "dm:owner", title: "e", brief: "f" }).id).toBe("s3");
  });

  it("keeps the owning scope on the record only", () => {
    const store = new SubsessionStore(path);
    const t = store.create({ parentKey: "telegram:-100", title: "a", brief: "b", quote: ["do it"] });
    expect(store.get(t.id)).toMatchObject({ parentKey: "telegram:-100", status: "queued", quote: ["do it"], startDelivered: false, pendingInput: [] });
  });

  it("persists across instances and writes a backup", () => {
    new SubsessionStore(path).create({ parentKey: "dm:owner", title: "a", brief: "b" });
    expect(existsSync(`${path}.bak`)).toBe(true);
    expect(new SubsessionStore(path).list()).toHaveLength(1);
  });

  it("reads a missing table as empty", () => {
    const store = new SubsessionStore(path);
    expect(store.list()).toEqual([]);
    expect(store.state()).toBe("missing");
  });

  it("recovers a missing primary from its backup (a lost write, not a fresh install)", () => {
    new SubsessionStore(path).create({ parentKey: "dm:owner", title: "a", brief: "b" });
    rmSync(path);
    const store = new SubsessionStore(path);
    expect(store.list()).toHaveLength(1);
    expect(store.state()).toBe("recovered");
  });

  it("refuses a missing primary next to an unreadable backup, instead of reading it as empty", () => {
    new SubsessionStore(path).create({ parentKey: "dm:owner", title: "a", brief: "b" });
    rmSync(path);
    writeFileSync(`${path}.bak`, "{broken");
    const store = new SubsessionStore(path);
    expect(() => store.list()).toThrow(SubsessionStoreError);
    expect(store.state()).toBe("unreadable");
    expect(() => store.create({ parentKey: "dm:owner", title: "x", brief: "y" })).toThrow(SubsessionStoreError);
  });

  it("never drops accepted input, and a guard refuses a transition without writing", () => {
    const store = new SubsessionStore(path, { strictTransitions: true });
    const t = store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    for (let i = 0; i < 30; i++) store.transition(t.id, "relay", { patch: (r) => { appendInput(r, `m${i}`, HARNESS); } });
    expect(store.get(t.id)?.pendingInput).toHaveLength(30);
    const refused = store.transition(t.id, "relay", { guard: () => "full", patch: (r) => { appendInput(r, "x", HARNESS); } });
    expect(refused).toMatchObject({ ok: false, refused: "full" });
    expect(store.get(t.id)?.pendingInput).toHaveLength(30);
  });

  it("reserves ids so a new task never reuses one the registry still holds", () => {
    const store = new SubsessionStore(path);
    store.reserveIdsThrough(4);
    expect(store.create({ parentKey: "dm:owner", title: "a", brief: "b" }).id).toBe("s5");
    store.reserveIdsThrough(2);
    expect(store.create({ parentKey: "dm:owner", title: "a", brief: "b" }).id).toBe("s6");
  });

  it("recovers a 0-byte table from its backup and keeps the bad file", () => {
    new SubsessionStore(path).create({ parentKey: "dm:owner", title: "a", brief: "b" });
    writeFileSync(path, "");
    const store = new SubsessionStore(path);
    expect(store.list()).toHaveLength(1);
    expect(store.state()).toBe("recovered");
    expect(readdirSync(join(dir, "data")).some((f) => f.includes(".corrupt-"))).toBe(true);
  });

  it("refuses every read and write when the table and its backup are unreadable", () => {
    new SubsessionStore(path).create({ parentKey: "dm:owner", title: "a", brief: "b" });
    writeFileSync(path, "{not json");
    writeFileSync(`${path}.bak`, "");
    const store = new SubsessionStore(path);
    expect(() => store.list()).toThrow(SubsessionStoreError);
    expect(store.state()).toBe("unreadable");
    expect(() => store.create({ parentKey: "dm:owner", title: "x", brief: "y" })).toThrow(SubsessionStoreError);
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });

  it("update() may not change the lifecycle", () => {
    const store = new SubsessionStore(path);
    const t = store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    expect(() => store.update(t.id, (r) => { r.status = "active"; })).toThrow(/transition/);
    expect(store.get(t.id)?.status).toBe("queued");
  });

  it("a transition patch may not change the status", () => {
    const store = new SubsessionStore(path);
    const t = store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    expect(() => store.transition(t.id, "start", { patch: (r) => { r.status = "finished"; } })).toThrow(/patch/);
    expect(store.get(t.id)?.status).toBe("queued");
  });

  it("banks active time when a task leaves active", () => {
    let now = 1_000;
    const store = new SubsessionStore(path, { now: () => now });
    const t = store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    store.transition(t.id, "start");
    now += 5_000;
    store.transition(t.id, "stuck");
    expect(store.get(t.id)).toMatchObject({ activeMs: 5_000 });
    expect(store.get(t.id)?.activeSince).toBeUndefined();
  });

  // 81 locked, fsynced writes: seconds on a slow disk under a full parallel run.
  it("caps the transition log", { timeout: 30_000 }, () => {
    const store = new SubsessionStore(path);
    const t = store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    store.transition(t.id, "start");
    for (let i = 0; i < 40; i++) {
      store.transition(t.id, "stuck");
      store.transition(t.id, "owner_message");
    }
    expect(store.get(t.id)?.transitions).toHaveLength(TRANSITION_LOG_KEEP);
  });

  it("parseTable defaults fields a newer version added and rejects a bad core field", () => {
    const parsed = parseTable({ version: 1, nextId: 2, tasks: [{ id: "s1", sessionKey: "task:s1", parentKey: "dm:o", title: "t", brief: "b", status: "active" }] });
    expect(parsed.tasks[0]).toMatchObject({ resumeNeeded: false, startDelivered: false, pendingInput: [], transitions: [] });
    expect(() => parseTable({ version: 1, nextId: 2, tasks: [{ id: "s1", status: "interrupted" }] })).toThrow();
    expect(() => parseTable({ version: 2, nextId: 1, tasks: [] })).toThrow();
  });
});
