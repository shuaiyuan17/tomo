import { describe, it, expect } from "vitest";

// Test the silent reply detection (extracted logic)
function isSilentReply(text: string): boolean {
  return /^\s*NO_REPLY\s*$/i.test(text);
}

describe("isSilentReply", () => {
  it("detects NO_REPLY", () => {
    expect(isSilentReply("NO_REPLY")).toBe(true);
  });

  it("detects with whitespace", () => {
    expect(isSilentReply("  NO_REPLY  ")).toBe(true);
    expect(isSilentReply("\nNO_REPLY\n")).toBe(true);
  });

  it("case insensitive", () => {
    expect(isSilentReply("no_reply")).toBe(true);
    expect(isSilentReply("No_Reply")).toBe(true);
  });

  it("rejects messages with content", () => {
    expect(isSilentReply("Here is a response. NO_REPLY")).toBe(false);
    expect(isSilentReply("NO_REPLY but also this")).toBe(false);
    expect(isSilentReply("hello")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isSilentReply("")).toBe(false);
  });
});

// Test timestamp injection (extracted logic)
function injectTimestamp(text: string): string {
  const now = new Date("2026-04-06T17:30:00-07:00");
  const weekday = now.toLocaleDateString("en-US", { weekday: "short" });
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const date = `${mm}/${dd}`;
  const time = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const tz = now.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  return `[${weekday} ${date} ${time} ${tz}] ${text}`;
}

describe("injectTimestamp", () => {
  it("prepends timestamp to message", () => {
    const result = injectTimestamp("hello");
    expect(result).toMatch(/^\[.+ \d{2}\/\d{2} \d{2}:\d{2} .+\] hello$/);
  });

  it("preserves original text", () => {
    const result = injectTimestamp("test message");
    expect(result).toContain("test message");
  });
});

// Test MEDIA extraction (extracted logic from agent.ts)
const MEDIA_RE = /\bMEDIA:\s*"?([^\n"]+)"?/gi;

function extractMedia(text: string): { cleanText: string; mediaPaths: string[] } {
  const mediaPaths: string[] = [];
  const cleanText = text.replace(MEDIA_RE, (_match, path) => {
    mediaPaths.push(path.trim());
    return "";
  }).trim();
  return { cleanText, mediaPaths };
}

describe("extractMedia", () => {
  it("extracts single media path", () => {
    const { cleanText, mediaPaths } = extractMedia('Here is the image MEDIA: "/tmp/photo.png"');
    expect(mediaPaths).toEqual(["/tmp/photo.png"]);
    expect(cleanText).toBe("Here is the image");
  });

  it("extracts multiple media paths", () => {
    const { cleanText, mediaPaths } = extractMedia(
      'First image MEDIA: "/tmp/a.png"\nSecond image MEDIA: "/tmp/b.jpg"',
    );
    expect(mediaPaths).toEqual(["/tmp/a.png", "/tmp/b.jpg"]);
    expect(cleanText).toMatch(/First image\s*\nSecond image/);
  });

  it("handles unquoted paths", () => {
    const { mediaPaths } = extractMedia("MEDIA: /tmp/photo.png");
    expect(mediaPaths).toEqual(["/tmp/photo.png"]);
  });

  it("returns empty array when no media", () => {
    const { cleanText, mediaPaths } = extractMedia("Just a normal message");
    expect(mediaPaths).toEqual([]);
    expect(cleanText).toBe("Just a normal message");
  });

  it("handles empty string", () => {
    const { cleanText, mediaPaths } = extractMedia("");
    expect(mediaPaths).toEqual([]);
    expect(cleanText).toBe("");
  });

  it("case insensitive matching", () => {
    const { mediaPaths } = extractMedia('media: "/tmp/test.png"');
    expect(mediaPaths).toEqual(["/tmp/test.png"]);
  });
});

// Test tool input summarization (extracted logic from agent.ts)
function summarizeToolInput(name: string, input?: Record<string, unknown>): string {
  if (!input) return name;
  switch (name) {
    case "Read": return `Read ${input.file_path}`;
    case "Write": return `Write ${input.file_path}`;
    case "Edit": return `Edit ${input.file_path}`;
    case "Bash": return `Bash: ${String(input.command).slice(0, 80)}`;
    case "Glob": return `Glob ${input.pattern}`;
    case "Grep": return `Grep "${input.pattern}"`;
    case "WebSearch": return `WebSearch: ${input.query}`;
    case "WebFetch": return `WebFetch: ${input.url}`;
    default: return `${name}: ${JSON.stringify(input).slice(0, 100)}`;
  }
}

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
    const longCommand = "npm run build && npm test && echo done " + "x".repeat(100);
    const result = summarizeToolInput("Bash", { command: longCommand });
    expect(result.startsWith("Bash: ")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(86); // "Bash: " (6) + 80
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
    const input = { key: "a".repeat(200) };
    const result = summarizeToolInput("CustomTool", input);
    expect(result.startsWith("CustomTool: ")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(112); // "CustomTool: " (12) + 100
  });
});

// Test AVAILABLE_MODELS (extracted from Agent class)
describe("AVAILABLE_MODELS", () => {
  const AVAILABLE_MODELS: Record<string, string> = {
    "sonnet": "claude-sonnet-4-6[1m]",
    "opus": "claude-opus-4-6[1m]",
    "haiku": "claude-haiku-4-5",
  };

  it("maps short names to full model IDs", () => {
    expect(AVAILABLE_MODELS["sonnet"]).toBe("claude-sonnet-4-6[1m]");
    expect(AVAILABLE_MODELS["opus"]).toBe("claude-opus-4-6[1m]");
    expect(AVAILABLE_MODELS["haiku"]).toBe("claude-haiku-4-5");
  });

  it("does not have unknown model keys", () => {
    expect(Object.keys(AVAILABLE_MODELS)).toEqual(["sonnet", "opus", "haiku"]);
  });
});
