import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// HERMETIC BY CONSTRUCTION, and it has to be done before the import below.
//
// `src/workspace/index.ts` resolves MEMORY_DIR once, at module load, from
// `defaultRuntimePaths` — which is itself a module-level const built from
// `homedir()` and `$TOMO_WORKSPACE`. So the paths this suite exercises are
// fixed by the environment as it stands at import time, and a static
// `import { buildSystemPrompt }` would bind them to the developer's real
// `~/.tomo/workspace` before any hook could intervene.
//
// That was not theoretical. `buildSystemPrompt()` calls `mkdirSync(MEMORY_DIR)`
// on every invocation, and two describes below overwrite `MEMORY.md` with
// fixture text and restore it afterwards — against the real file. A run that
// died between `beforeEach` and `afterEach` left the owner's memory index
// replaced by three lines of test data, and a daemon reading it inside that
// window saw the fixture.
//
// Stub both keys: `TOMO_WORKSPACE` takes precedence over `$HOME` in
// `createRuntimePaths`, so stubbing HOME alone would still resolve to the real
// workspace for anyone who has it set — which every Tomo developer does.
const TEST_HOME = mkdtempSync(join(tmpdir(), "tomo-workspace-test-"));
const TOMO_WORKSPACE = join(TEST_HOME, ".tomo", "workspace");
vi.stubEnv("HOME", TEST_HOME);
vi.stubEnv("TOMO_WORKSPACE", TOMO_WORKSPACE);

const { buildSystemPrompt } = await import("../src/workspace/index.js");

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("buildSystemPrompt", () => {
  it("includes all sections", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("SOUL");
    expect(prompt).toContain("AGENT");
    expect(prompt).toContain("IDENTITY");
    expect(prompt).toContain("MEMORY");
    expect(prompt).toContain("HARNESS");
  });

  it("includes NO_REPLY instruction in harness", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("NO_REPLY");
    expect(prompt).toContain("suppresses delivery");
  });

  it("includes harness-event envelope instruction in harness", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("<tomo-event");
    expect(prompt).toContain("System:");
    expect(prompt).toContain("harness, not a human");
  });

  it("includes memory directory path", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(".tomo/workspace/memory");
  });

  it("includes proactive memory instructions", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Be proactive");
    expect(prompt).toContain("Don't wait to be told");
  });

  describe("loads MEMORY.md content", () => {
    const memoryDir = join(TOMO_WORKSPACE, "memory");
    const memoryFile = join(memoryDir, "MEMORY.md");

    beforeEach(() => {
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(memoryFile, "- [Test](test.md) — test memory\n");
    });

    afterEach(() => {
      rmSync(memoryFile, { force: true });
    });

    it("includes memory entry in prompt", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("test memory");
    });
  });

  describe("private memory filtering for group sessions", () => {
    const memoryDir = join(TOMO_WORKSPACE, "memory");
    const memoryFile = join(memoryDir, "MEMORY.md");

    beforeEach(() => {
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(memoryFile, [
        "- [Public](public.md) — visible everywhere",
        "- [Private](private/secret.md) — DM only",
        "- [PrivateDotSlash](./private/other.md) — DM only too",
      ].join("\n") + "\n");
    });

    afterEach(() => {
      rmSync(memoryFile, { force: true });
    });

    it("DM sessions see private/ entries", () => {
      const prompt = buildSystemPrompt({ isGroup: false });
      expect(prompt).toContain("visible everywhere");
      expect(prompt).toContain("DM only");
      expect(prompt).toContain("DM only too");
    });

    it("group sessions have private/ entries filtered out", () => {
      const prompt = buildSystemPrompt({ isGroup: true });
      expect(prompt).toContain("visible everywhere");
      expect(prompt).not.toContain("DM only");
      expect(prompt).not.toContain("DM only too");
    });

    it("DM prompt tells the agent to use memory/private/ for sensitive notes", () => {
      const prompt = buildSystemPrompt({ isGroup: false });
      expect(prompt).toContain("memory/private/");
      expect(prompt).toMatch(/save the memory file under/i);
    });

    it("group prompt tells the agent that memory/private/ is unreachable", () => {
      const prompt = buildSystemPrompt({ isGroup: true });
      expect(prompt).toContain("memory/private/");
      expect(prompt).toMatch(/restricted to DM sessions/i);
    });
  });
});
