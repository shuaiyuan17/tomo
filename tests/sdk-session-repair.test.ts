import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repairSdkSessionFile } from "../src/sessions/repair.js";

const tmpDirs: string[] = [];

function tempSessionPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tomo-sdk-repair-"));
  tmpDirs.push(dir);
  return join(dir, "session.jsonl");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("repairSdkSessionFile", () => {
  it("removes empty text blocks when other content remains", () => {
    const path = tempSessionPath();
    writeFileSync(path, JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "pong" },
        ],
      },
    }) + "\n");

    const result = repairSdkSessionFile(path);

    expect(result.repaired).toBe(true);
    expect(result.changedBlocks).toBe(1);
    expect(existsSync(`${path}.repair.bak`)).toBe(true);
    const [event] = readFileSync(path, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(event.message.content).toEqual([{ type: "text", text: "pong" }]);
  });

  it("replaces all-empty text content with a non-empty placeholder", () => {
    const path = tempSessionPath();
    writeFileSync(path, JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "" }],
      },
    }) + "\n");

    const result = repairSdkSessionFile(path);

    expect(result.repaired).toBe(true);
    const [event] = readFileSync(path, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(event.message.content[0].type).toBe("text");
    expect(event.message.content[0].text.length).toBeGreaterThan(0);
  });

  it("repairs nested tool_result text content", () => {
    const path = tempSessionPath();
    writeFileSync(path, JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_123",
          content: [
            { type: "text", text: "" },
            { type: "text", text: "result" },
          ],
        }],
      },
    }) + "\n");

    const result = repairSdkSessionFile(path);

    expect(result.repaired).toBe(true);
    const [event] = readFileSync(path, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(event.message.content[0].content).toEqual([{ type: "text", text: "result" }]);
  });
});

