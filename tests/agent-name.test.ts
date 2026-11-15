import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentNameReader, DEFAULT_AGENT_NAME, parseIdentityName } from "../src/workspace/agent-name.js";
import { composerStatus, requestLabels, TYPING_ACTIVITY } from "../web/src/composer-status.js";
import { agentNameOf } from "../web/src/agent-name.js";

describe("parseIdentityName", () => {
  it("reads the Name line tomo init writes, with markdown bold", () => {
    expect(parseIdentityName("# IDENTITY.md - Who Am I?\n\n- **Name:** Claw\n- **Pronouns:** he / him")).toBe("Claw");
  });
  it("accepts plainer and Chinese forms", () => {
    expect(parseIdentityName("Name: Mochi")).toBe("Mochi");
    expect(parseIdentityName("* **Name**: _Juniper_")).toBe("Juniper");
    expect(parseIdentityName("- **名字：** 小爪")).toBe("小爪");
    expect(parseIdentityName("名字: 克劳")).toBe("克劳");
    expect(parseIdentityName("- **name:** `Tomo-Two`")).toBe("Tomo-Two");
  });
  it("drops a trailing note and link markup", () => {
    expect(parseIdentityName("- **Name:** Claw (he/him)")).toBe("Claw");
    expect(parseIdentityName("- **Name:** Claw — picked 2026-04-17")).toBe("Claw");
    expect(parseIdentityName("- **Name:** [Claw](https://claw.example)")).toBe("Claw");
  });
  it("no name line, or an empty one: undefined", () => {
    expect(parseIdentityName("- **Vibe:** calm\n- **Nickname list:** x")).toBeUndefined();
    expect(parseIdentityName("- **Name:**   ")).toBeUndefined();
    expect(parseIdentityName("")).toBeUndefined();
  });
});

describe("AgentNameReader", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tomo-agent-name-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it("config agent.name wins over IDENTITY.md", () => {
    writeFileSync(join(dir, "IDENTITY.md"), "- **Name:** Claw\n");
    expect(new AgentNameReader({ configured: "Pip", workspaceDir: dir }).name()).toBe("Pip");
    expect(new AgentNameReader({ configured: "  ", workspaceDir: dir }).name()).toBe("Claw");
  });
  it("falls back to Tomo with no config, no file, or no name line", () => {
    expect(new AgentNameReader({ workspaceDir: dir }).name()).toBe(DEFAULT_AGENT_NAME);
    expect(new AgentNameReader({}).name()).toBe("Tomo");
    writeFileSync(join(dir, "IDENTITY.md"), "- **Vibe:** calm\n");
    expect(new AgentNameReader({ workspaceDir: dir }).name()).toBe("Tomo");
  });
  it("an edited IDENTITY.md is picked up (mtime/size cache)", () => {
    const file = join(dir, "IDENTITY.md");
    writeFileSync(file, "- **Name:** Claw\n");
    const reader = new AgentNameReader({ workspaceDir: dir });
    expect(reader.name()).toBe("Claw");
    writeFileSync(file, "- **Name:** Pebble\n");
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(reader.name()).toBe("Pebble");
  });
});

describe("the UI words the agent by name", () => {
  it("status line labels and the typing indicator use the name; product wording stays", () => {
    expect(requestLabels("Claw").running).toBe("Claw is working…");
    expect(requestLabels("Claw").unknown).toContain("Claw may already have acted");
    expect(composerStatus({ activity: TYPING_ACTIVITY, note: { text: "", at: "" }, latest: undefined, settled: null, agent: "Claw" })).toBe("Claw is working…");
    expect(composerStatus({ activity: undefined, note: { text: "", at: "" }, latest: { requestId: "r", state: "running" }, settled: null })).toBe("Tomo is working…");
  });
  it("an older daemon without agentName, or a blank one, reads Tomo", () => {
    expect(agentNameOf(undefined)).toBe("Tomo");
    expect(agentNameOf("  ")).toBe("Tomo");
    expect(agentNameOf("Claw")).toBe("Claw");
  });
});
