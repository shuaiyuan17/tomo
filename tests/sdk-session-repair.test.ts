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

  it("fills all-empty assistant text from Tomo transcript when timestamps match", () => {
    const path = tempSessionPath();
    writeFileSync(path, JSON.stringify({
      type: "assistant",
      timestamp: "2026-05-31T21:45:41.814Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "" }],
      },
    }) + "\n");

    const result = repairSdkSessionFile(path, [{
      role: "assistant",
      content: "real reply from tomo transcript",
      channel: "telegram",
      timestamp: Date.parse("2026-05-31T21:45:41.900Z"),
    }]);

    expect(result.repaired).toBe(true);
    expect(result.transcriptFilled).toBe(1);
    expect(result.placeholderFilled).toBe(0);
    const [event] = readFileSync(path, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(event.message.content).toEqual([{ type: "text", text: "real reply from tomo transcript" }]);
  });

  it("matches multiple empty assistant events to transcript messages in order", () => {
    const path = tempSessionPath();
    writeFileSync(path, [
      {
        type: "assistant",
        timestamp: "2026-05-31T21:45:41.814Z",
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-05-31T21:45:59.046Z",
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");

    const result = repairSdkSessionFile(path, [
      { role: "assistant", content: "first", channel: "telegram", timestamp: Date.parse("2026-05-31T21:45:42.000Z") },
      { role: "assistant", content: "second", channel: "telegram", timestamp: Date.parse("2026-05-31T21:45:59.200Z") },
    ]);

    expect(result.transcriptFilled).toBe(2);
    const events = readFileSync(path, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events[0].message.content[0].text).toBe("first");
    expect(events[1].message.content[0].text).toBe("second");
  });

  it("does not let a preceding tool-use assistant event consume transcript text", () => {
    const path = tempSessionPath();
    writeFileSync(path, [
      {
        type: "assistant",
        timestamp: "2026-05-31T21:45:40.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_123", name: "Bash", input: { command: "date" } }],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-05-31T21:45:41.814Z",
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");

    const result = repairSdkSessionFile(path, [
      { role: "assistant", content: "THE REAL REPLY", channel: "telegram", timestamp: Date.parse("2026-05-31T21:45:41.900Z") },
    ]);

    expect(result.transcriptFilled).toBe(1);
    expect(result.placeholderFilled).toBe(0);
    const events = readFileSync(path, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events[0].message.content[0].type).toBe("tool_use");
    expect(events[1].message.content).toEqual([{ type: "text", text: "THE REAL REPLY" }]);
  });

  it("does not consume transcript text when dropping empty text before tool_use", () => {
    const path = tempSessionPath();
    writeFileSync(path, [
      {
        type: "assistant",
        timestamp: "2026-05-31T21:45:40.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "" },
            { type: "tool_use", id: "toolu_123", name: "Bash", input: { command: "date" } },
          ],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-05-31T21:45:41.814Z",
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");

    const result = repairSdkSessionFile(path, [
      { role: "assistant", content: "THE REAL REPLY", channel: "telegram", timestamp: Date.parse("2026-05-31T21:45:41.900Z") },
    ]);

    expect(result.transcriptFilled).toBe(1);
    expect(result.placeholderFilled).toBe(0);
    const events = readFileSync(path, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events[0].message.content).toEqual([
      { type: "tool_use", id: "toolu_123", name: "Bash", input: { command: "date" } },
    ]);
    expect(events[1].message.content).toEqual([{ type: "text", text: "THE REAL REPLY" }]);
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
