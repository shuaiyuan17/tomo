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

  it("includes System: prefix instruction in harness", () => {
    const prompt = buildSystemPrompt();
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
});
