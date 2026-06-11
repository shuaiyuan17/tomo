import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SummonStore } from "../src/sessions/summon-store.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tomo-test-summon-store");
const FILE = join(TEST_DIR, "summons.json");

describe("SummonStore", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("persists summons across instances", () => {
    const store = new SummonStore(FILE, 60_000);
    store.set("telegram:-987", "alice", 1000);
    expect(existsSync(FILE)).toBe(true);

    const reloaded = new SummonStore(FILE, 60_000);
    const { entry } = reloaded.get("telegram:-987", 2000);
    expect(entry?.identity).toBe("alice");
    expect(entry?.summonedAt).toBe(1000);
  });

  it("persists deletes", () => {
    const store = new SummonStore(FILE, 60_000);
    store.set("telegram:-987", "alice", 1000);
    expect(store.delete("telegram:-987")).toBe(true);
    expect(store.delete("telegram:-987")).toBe(false);

    const reloaded = new SummonStore(FILE, 60_000);
    expect(reloaded.get("telegram:-987", 2000)).toEqual({});
  });

  it("expires entries after inactivity and reports them once", () => {
    const store = new SummonStore(FILE, 1000);
    store.set("telegram:-987", "alice", 1000);

    expect(store.get("telegram:-987", 1500).entry?.identity).toBe("alice");

    const lapsed = store.get("telegram:-987", 2500);
    expect(lapsed.entry).toBeUndefined();
    expect(lapsed.expired?.identity).toBe("alice");

    // Removed as a side effect — second lookup reports nothing
    expect(store.get("telegram:-987", 2600)).toEqual({});
  });

  it("touch resets the expiry clock", () => {
    const store = new SummonStore(FILE, 1000);
    store.set("telegram:-987", "alice", 1000);

    store.touch("telegram:-987", 1900);
    expect(store.get("telegram:-987", 2500).entry?.identity).toBe("alice");
    expect(store.get("telegram:-987", 3000).expired?.identity).toBe("alice");
  });

  it("never expires when expiryMs <= 0", () => {
    const store = new SummonStore(FILE, 0);
    store.set("telegram:-987", "alice", 1000);
    expect(store.get("telegram:-987", Number.MAX_SAFE_INTEGER).entry?.identity).toBe("alice");
  });

  it("works in-memory with a null file path", () => {
    const store = new SummonStore(null, 60_000);
    store.set("telegram:-987", "alice", 1000);
    expect(store.get("telegram:-987", 2000).entry?.identity).toBe("alice");
    expect(existsSync(FILE)).toBe(false);
  });

  it("survives a corrupt file by starting empty", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const store = new SummonStore(FILE, 60_000);
    store.set("telegram:-987", "alice", 1000);

    writeFileSync(FILE, "not json", "utf-8");

    const reloaded = new SummonStore(FILE, 60_000);
    expect(reloaded.get("telegram:-987", 2000)).toEqual({});
  });
});
