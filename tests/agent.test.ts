import { describe, it, expect } from "vitest";
import { normalizeSendTarget } from "../src/agent/send-target.js";
import { MODEL_ALIASES, resolveModelName } from "../src/models.js";
import {
  CHATGPT_SUBSCRIPTION_DEFAULT_MODEL,
  inferLiteLlmMode,
  isChatGptSubscriptionModel,
  liteLlmModeLabel,
  parseLiteLlmMode,
} from "../src/litellm.js";

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
const MEDIA_RE = /\bMEDIA:\s*(?:"([^"\n]+)"|([^\s\n"]+))/gi;
const STICKER_RE = /\bSTICKER:\s*(?:"([^"\n]+)"|([^\s\n"]+))/gi;
const ATTACHMENT_TAG_RE = /\b(?:MEDIA|STICKER):\s*(?:"[^"\n]+"|[^\s\n"]+)/gi;

function extractMedia(text: string): { cleanText: string; mediaPaths: string[] } {
  const mediaPaths: string[] = [];
  const cleanText = text.replace(MEDIA_RE, (_match, quotedPath, unquotedPath) => {
    mediaPaths.push(String(quotedPath ?? unquotedPath).trim());
    return "";
  }).trim();
  return { cleanText, mediaPaths };
}

function extractAttachments(text: string): { cleanText: string; mediaPaths: string[]; stickerIds: string[] } {
  const mediaPaths: string[] = [];
  const stickerIds: string[] = [];
  const withoutMedia = text.replace(MEDIA_RE, (_match, quotedPath, unquotedPath) => {
    mediaPaths.push(String(quotedPath ?? unquotedPath).trim());
    return "";
  });
  const cleanText = withoutMedia.replace(STICKER_RE, (_match, quotedId, unquotedId) => {
    stickerIds.push(String(quotedId ?? unquotedId).trim());
    return "";
  }).trim();
  return { cleanText, mediaPaths, stickerIds };
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

  it("handles quoted paths with spaces", () => {
    const { cleanText, mediaPaths } = extractMedia('Here is the image MEDIA:"/tmp/my photo.png"');
    expect(mediaPaths).toEqual(["/tmp/my photo.png"]);
    expect(cleanText).toBe("Here is the image");
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

describe("extractAttachments", () => {
  it("extracts sticker file ids and strips tags from text", () => {
    const { cleanText, mediaPaths, stickerIds } = extractAttachments("here STICKER:CAACAgQAAxkBAAE123 ok");
    expect(cleanText).toBe("here  ok");
    expect(mediaPaths).toEqual([]);
    expect(stickerIds).toEqual(["CAACAgQAAxkBAAE123"]);
  });

  it("extracts media and sticker tags together", () => {
    const { cleanText, mediaPaths, stickerIds } = extractAttachments('Look MEDIA:"/tmp/a.png" STICKER:"CAAC-123"');
    expect(cleanText).toBe("Look");
    expect(mediaPaths).toEqual(["/tmp/a.png"]);
    expect(stickerIds).toEqual(["CAAC-123"]);
  });

  it("strips only the sticker tag from streamed text", () => {
    const streamed = "here is STICKER:CAAC123 and more text".replace(ATTACHMENT_TAG_RE, "").trim();
    expect(streamed).toBe("here is  and more text");
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

describe("model resolution", () => {
  it("maps short names to full model IDs", () => {
    expect(MODEL_ALIASES["sonnet"]).toBe("claude-sonnet-4-6");
    expect(MODEL_ALIASES["sonnet-1m"]).toBe("claude-sonnet-4-6[1m]");
    expect(MODEL_ALIASES["opus"]).toBe("claude-opus-4-8");
    expect(MODEL_ALIASES["opus-1m"]).toBe("claude-opus-4-8[1m]");
    expect(MODEL_ALIASES["haiku"]).toBe("claude-haiku-4-5");
  });

  it("does not have unknown model keys", () => {
    expect(Object.keys(MODEL_ALIASES)).toEqual(["sonnet", "sonnet-1m", "opus", "opus-1m", "haiku"]);
  });

  it("accepts LiteLLM provider/model names", () => {
    expect(resolveModelName(CHATGPT_SUBSCRIPTION_DEFAULT_MODEL)).toBe(CHATGPT_SUBSCRIPTION_DEFAULT_MODEL);
    expect(resolveModelName("openrouter/openai/gpt-4o-mini")).toBe("openrouter/openai/gpt-4o-mini");
  });

  it("rejects typo-like Claude names that are not gateway provider/model names", () => {
    expect(resolveModelName("claude-sonnet-4.7")).toBeNull();
  });
});

describe("LiteLLM helpers", () => {
  it("defaults to a generic Anthropic-compatible proxy mode", () => {
    expect(parseLiteLlmMode(undefined)).toBe("anthropic-compatible");
    expect(parseLiteLlmMode("custom")).toBe("anthropic-compatible");
    expect(liteLlmModeLabel("anthropic-compatible")).toBe("Anthropic-compatible proxy");
  });

  it("accepts aliases for ChatGPT subscription mode", () => {
    expect(parseLiteLlmMode("chatgpt")).toBe("chatgpt-subscription");
    expect(parseLiteLlmMode("openai-subscription")).toBe("chatgpt-subscription");
    expect(liteLlmModeLabel("chatgpt-subscription")).toBe("ChatGPT subscription");
  });

  it("infers ChatGPT subscription mode for old chatgpt/* gateway configs", () => {
    expect(inferLiteLlmMode(undefined, CHATGPT_SUBSCRIPTION_DEFAULT_MODEL)).toBe("chatgpt-subscription");
    expect(inferLiteLlmMode(undefined, "claude-sonnet-4-6[1m]")).toBe("anthropic-compatible");
    expect(inferLiteLlmMode("anthropic-compatible", CHATGPT_SUBSCRIPTION_DEFAULT_MODEL)).toBe("anthropic-compatible");
  });

  it("detects ChatGPT subscription model names", () => {
    expect(isChatGptSubscriptionModel(CHATGPT_SUBSCRIPTION_DEFAULT_MODEL)).toBe(true);
    expect(isChatGptSubscriptionModel("openrouter/openai/gpt-4o-mini")).toBe(false);
  });
});

describe("normalizeSendTarget", () => {
  const identities = [{ name: "Shuai" }, { name: "Alice" }];

  it("returns lowercase dm: key for an identity name matching config casing", () => {
    expect(normalizeSendTarget("Shuai", identities)).toEqual({
      sessionKey: "dm:shuai",
      identityName: "Shuai",
    });
  });

  it("returns the same lowercase dm: key regardless of caller's casing", () => {
    // Regression for the duplicate-session bug: caller using identity name
    // verbatim from config ("Shuai") used to spawn dm:Shuai, parallel to the
    // dm:shuai built by the inbound path (router.ts toLowerCases).
    expect(normalizeSendTarget("Shuai", identities)?.sessionKey).toBe("dm:shuai");
    expect(normalizeSendTarget("shuai", identities)?.sessionKey).toBe("dm:shuai");
    expect(normalizeSendTarget("SHUAI", identities)?.sessionKey).toBe("dm:shuai");
  });

  it("returns null for an unknown identity name", () => {
    expect(normalizeSendTarget("Eve", identities)).toBeNull();
  });

  it("lowercases the name part of a dm: session key", () => {
    expect(normalizeSendTarget("dm:Shuai", identities)).toEqual({ sessionKey: "dm:shuai" });
    expect(normalizeSendTarget("dm:SHUAI", identities)).toEqual({ sessionKey: "dm:shuai" });
    expect(normalizeSendTarget("dm:shuai", identities)).toEqual({ sessionKey: "dm:shuai" });
  });

  it("does not validate dm: keys against identities (cron / fallback paths may reference removed names)", () => {
    expect(normalizeSendTarget("dm:eve", identities)).toEqual({ sessionKey: "dm:eve" });
  });

  it("returns channel keys unchanged (case preserved for chatId hashes)", () => {
    expect(normalizeSendTarget("imessage:any;+;ABC123DEF", identities)).toEqual({
      sessionKey: "imessage:any;+;ABC123DEF",
    });
    expect(normalizeSendTarget("telegram:-1001234567", identities)).toEqual({
      sessionKey: "telegram:-1001234567",
    });
  });
});
