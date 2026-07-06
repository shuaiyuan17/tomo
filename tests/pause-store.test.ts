import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PauseStore } from "../src/sessions/pause-store.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tomo-test-pause-store");
const FILE = join(TEST_DIR, "pauses.json");

describe("PauseStore", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("persists pauses across instances", () => {
    const store = new PauseStore(FILE);
    store.pause("telegram:-987", "Kevin", 1000);
    expect(existsSync(FILE)).toBe(true);

    const reloaded = new PauseStore(FILE);
    expect(reloaded.isPaused("telegram:-987")).toBe(true);
    expect(reloaded.get("telegram:-987")).toEqual({ pausedAt: 1000, pausedBy: "Kevin" });
  });

  it("persists resumes", () => {
    const store = new PauseStore(FILE);
    store.pause("telegram:-987", "Kevin", 1000);
    expect(store.resume("telegram:-987")).toBe(true);
    expect(store.resume("telegram:-987")).toBe(false);

    const reloaded = new PauseStore(FILE);
    expect(reloaded.isPaused("telegram:-987")).toBe(false);
  });

  it("tracks keys independently", () => {
    const store = new PauseStore(FILE);
    store.pause("telegram:-987");
    expect(store.isPaused("telegram:-987")).toBe(true);
    expect(store.isPaused("telegram:-111")).toBe(false);
  });

  it("works purely in memory with a null filePath", () => {
    const store = new PauseStore(null);
    store.pause("telegram:-987");
    expect(store.isPaused("telegram:-987")).toBe(true);
    expect(existsSync(FILE)).toBe(false);
  });

  it("starts empty when the file is corrupt", () => {
    writeFileSync(FILE, "{ not json\n");
    const store = new PauseStore(FILE);
    expect(store.isPaused("telegram:-987")).toBe(false);
  });
});
