import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSystemPrompt } from "../src/workspace/index.js";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TOMO_WORKSPACE = join(homedir(), ".tomo", "workspace");

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
    let originalContent: string | null = null;

    beforeEach(() => {
      mkdirSync(memoryDir, { recursive: true });
      originalContent = existsSync(memoryFile) ? readFileSync(memoryFile, "utf-8") : null;
      writeFileSync(memoryFile, "- [Test](test.md) — test memory\n");
    });

    afterEach(() => {
      if (originalContent !== null) {
        writeFileSync(memoryFile, originalContent);
      } else {
        rmSync(memoryFile, { force: true });
      }
    });

    it("includes memory entry in prompt", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("test memory");
    });
  });

  describe("private memory filtering for group sessions", () => {
    const memoryDir = join(TOMO_WORKSPACE, "memory");
    const memoryFile = join(memoryDir, "MEMORY.md");
    let originalContent: string | null = null;

    beforeEach(() => {
      mkdirSync(memoryDir, { recursive: true });
      originalContent = existsSync(memoryFile) ? readFileSync(memoryFile, "utf-8") : null;
      writeFileSync(memoryFile, [
        "- [Public](public.md) — visible everywhere",
        "- [Private](private/secret.md) — DM only",
        "- [PrivateDotSlash](./private/other.md) — DM only too",
      ].join("\n") + "\n");
    });

    afterEach(() => {
      if (originalContent !== null) {
        writeFileSync(memoryFile, originalContent);
      } else {
        rmSync(memoryFile, { force: true });
      }
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
