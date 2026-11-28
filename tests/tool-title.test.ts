import { describe, expect, it } from "vitest";
import { summarizeToolInput, toolTitle, toolTitleIsProse } from "../src/agent/tool-summary.js";

describe("toolTitle (what a reader sees on a folded tool row)", () => {
  it("titles a Bash call by the description the model wrote, on one line", () => {
    expect(toolTitle("Bash", { command: "npm test", description: "Run the\n test suite " })).toBe("Run the test suite");
  });
  it("falls back to the log summary without a description, and for every other tool", () => {
    expect(toolTitle("Bash", { command: "npm test" })).toBe("Bash: npm test");
    expect(toolTitle("Bash", { command: "npm test", description: "  " })).toBe("Bash: npm test");
    expect(toolTitle("Read", { file_path: "/a/b.ts", description: "ignored" })).toBe(summarizeToolInput("Read", { file_path: "/a/b.ts" }));
  });
  it("scrubs a secret out of a description as it does out of a command", () => {
    const secret = "sk-ant-api03-" + "a".repeat(40);
    expect(toolTitle("Bash", { command: "x", description: `Call the API with ${secret}` })).not.toContain(secret);
  });
  it("says when the title is the model's words (text face) rather than a command or path (monospace)", () => {
    expect(toolTitleIsProse("Bash", { command: "git status", description: "Check the working tree" })).toBe(true);
    expect(toolTitleIsProse("Agent", { description: "Review the release" })).toBe(true);
    expect(toolTitleIsProse("Bash", { command: "git status" })).toBe(false);
    expect(toolTitleIsProse("Bash", { command: "git status", description: "  " })).toBe(false);
    expect(toolTitleIsProse("Read", { file_path: "/a", description: "x" })).toBe(false);
  });
});

describe("summarizeToolInput", () => {
  it("returns tool name when no input", () => {
    expect(summarizeToolInput("Read")).toBe("Read");
    expect(summarizeToolInput("Bash")).toBe("Bash");
  });

  it("formats Read with file_path", () => {
    expect(summarizeToolInput("Read", { file_path: "/src/index.ts" })).toBe("Read /src/index.ts");
  });

  it("formats Write with file_path", () => {
    expect(summarizeToolInput("Write", { file_path: "/tmp/output.json" })).toBe("Write /tmp/output.json");
  });

  it("formats Edit with file_path", () => {
    expect(summarizeToolInput("Edit", { file_path: "/src/config.ts" })).toBe("Edit /src/config.ts");
  });

  it("formats Bash with truncated command", () => {
    const longCommand = "npm run build && npm test && echo done " + "x".repeat(1000);
    const result = summarizeToolInput("Bash", { command: longCommand });
    expect(result.startsWith("Bash: npm run build")).toBe(true);
    expect(result.length).toBe(506); // "Bash: " (6) + 500
  });

  it("formats Glob with pattern", () => {
    expect(summarizeToolInput("Glob", { pattern: "**/*.ts" })).toBe("Glob **/*.ts");
  });

  it("formats Grep with quoted pattern", () => {
    expect(summarizeToolInput("Grep", { pattern: "TODO" })).toBe('Grep "TODO"');
  });

  it("formats WebSearch with query", () => {
    expect(summarizeToolInput("WebSearch", { query: "vitest mocking" })).toBe("WebSearch: vitest mocking");
  });

  it("formats WebFetch with url", () => {
    expect(summarizeToolInput("WebFetch", { url: "https://example.com" })).toBe("WebFetch: https://example.com");
  });

  it("formats unknown tools with JSON truncation", () => {
    const input = { key: "a".repeat(1000) };
    const result = summarizeToolInput("CustomTool", input);
    expect(result.startsWith('CustomTool: {"key":"aaa')).toBe(true);
    expect(result.length).toBe(512); // "CustomTool: " (12) + 500
  });

  it("scrubs secret values before they reach the log line", () => {
    const result = summarizeToolInput("Bash", { command: "curl -H 'Authorization: Bearer abcdef123456' https://x" });
    expect(result.startsWith("Bash: curl")).toBe(true);
    expect(result).not.toContain("abcdef123456");
  });

  it("formats Agent/Task with subagent type and description", () => {
    expect(summarizeToolInput("Agent", { subagent_type: "Explore", description: "find callers" }))
      .toBe("Agent → Explore: find callers");
    expect(summarizeToolInput("Task", {})).toBe("Agent → ?: ");
  });
  it("an MCP call is `server · tool` and its first string value, not the raw name and JSON", () => {
    expect(toolTitle("mcp__mac-kit__mail_search", { limit: 5, query: "zagg  black\nfriday" })).toBe('mac-kit · mail_search "zagg black friday"');
    expect(toolTitle("mcp__claude_ai_Gmail__list", { limit: 5 })).toBe("claude_ai_Gmail · list");
    expect(toolTitle("mcp__docs__fetch", { url: "x".repeat(100) })).toBe(`docs · fetch "${"x".repeat(80)}…"`);
  });
});
