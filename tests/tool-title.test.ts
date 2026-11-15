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
