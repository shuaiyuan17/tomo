import { describe, it, expect } from "vitest";
import { normalizeSendTarget } from "../src/agent/send-target.js";
import { extractAttachments, extractMedia, isSilentReply } from "../src/agent/text-utils.js";
import { injectTimestamp } from "../src/agent/turn-runner.js";
import { summarizeToolInput } from "../src/agent/live-session.js";
import { DEFAULT_MODEL, MODEL_ALIASES, PICKER_MODELS, resolveModelName } from "../src/models.js";
import {
  CHATGPT_SUBSCRIPTION_DEFAULT_MODEL,
  inferLiteLlmMode,
  isChatGptSubscriptionModel,
  liteLlmModeLabel,
  parseLiteLlmMode,
} from "../src/litellm.js";

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
});

describe("model resolution", () => {
  it("maps short names to full model IDs", () => {
    // 5.5 family, 1M by default: [1m] ids where the SDK has a [1m] alias
    // (sonnet/opus/fable); the bundled binary handles the tag in its model
    // lookup. Haiku 5.5 is natively 1M and has no [1m] alias.
    expect(MODEL_ALIASES["opus"]).toBe("claude-opus-5-5[1m]");
    expect(MODEL_ALIASES["opus-1m"]).toBe("claude-opus-5-5[1m]");
    expect(MODEL_ALIASES["sonnet"]).toBe("claude-sonnet-5-5[1m]");
    expect(MODEL_ALIASES["sonnet-1m"]).toBe("claude-sonnet-5-5[1m]");
    expect(MODEL_ALIASES["haiku"]).toBe("claude-haiku-5-5");
    expect(MODEL_ALIASES["fable"]).toBe("claude-fable-5-1[1m]");
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5[1m]");
  });

  it("does not have unknown model keys", () => {
    expect(Object.keys(MODEL_ALIASES)).toEqual(["opus", "opus-1m", "sonnet", "sonnet-1m", "haiku", "fable"]);
  });

  it("pickers offer only the 5.5 family plus Fable 5.1, 1M by default, default first", () => {
    expect(PICKER_MODELS.map((m) => m.id)).toEqual(["claude-opus-5-5[1m]", "claude-sonnet-5-5[1m]", "claude-haiku-5-5", "claude-fable-5-1[1m]"]);
    expect(PICKER_MODELS.some((m) => /-4-|claude-(opus|sonnet)-5(\[|$)/.test(m.id))).toBe(false);
  });

  it("still accepts older explicit ids, so existing configs keep working", () => {
    for (const id of ["claude-sonnet-5[1m]", "claude-opus-5[1m]", "claude-opus-4-8[1m]", "claude-haiku-4-5", "claude-opus-5-5[1m]"]) {
      expect(resolveModelName(id)).toBe(id);
    }
  });

  it("accepts LiteLLM provider/model names", () => {
    expect(resolveModelName(CHATGPT_SUBSCRIPTION_DEFAULT_MODEL)).toBe(CHATGPT_SUBSCRIPTION_DEFAULT_MODEL);
    expect(resolveModelName("openrouter/openai/gpt-4o-mini")).toBe("openrouter/openai/gpt-4o-mini");
  });

  it("accepts arbitrary direct model IDs", () => {
    expect(resolveModelName("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(resolveModelName("claude-sonnet-5[1m]")).toBe("claude-sonnet-5[1m]");
    expect(resolveModelName("claude-sonnet-5-1")).toBe("claude-sonnet-5-1");
    expect(resolveModelName("future-model-20270101")).toBe("future-model-20270101");
  });

  it("rejects unsafe model names", () => {
    expect(resolveModelName("claude sonnet 5")).toBeNull();
    expect(resolveModelName("../claude-sonnet-5")).toBeNull();
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
    expect(inferLiteLlmMode(undefined, "claude-sonnet-5[1m]")).toBe("anthropic-compatible");
    expect(inferLiteLlmMode("anthropic-compatible", CHATGPT_SUBSCRIPTION_DEFAULT_MODEL)).toBe("anthropic-compatible");
  });

  it("detects ChatGPT subscription model names", () => {
    expect(isChatGptSubscriptionModel(CHATGPT_SUBSCRIPTION_DEFAULT_MODEL)).toBe(true);
    expect(isChatGptSubscriptionModel("openrouter/openai/gpt-4o-mini")).toBe(false);
  });
});

describe("normalizeSendTarget", () => {
  const owner = { name: "Alex", displayName: "Alexandra", telegram: ["12345"], imessage: ["+15551234567"] };

  it("returns the owner's lowercase dm: key for the owner's name, display name or \"owner\", in any casing", () => {
    // Regression for the duplicate-session bug: a caller using the name
    // verbatim from config ("Alex") used to spawn dm:Alex, parallel to the
    // dm:alex built by the inbound path (router.ts lowercases).
    for (const name of ["Alex", "alex", "ALEX", "Alexandra", "owner", "Owner"]) {
      expect(normalizeSendTarget(name, owner)).toEqual({ sessionKey: "dm:alex", identityName: "Alex" });
    }
  });

  it("returns null for any other bare name, and for any bare name with no owner", () => {
    expect(normalizeSendTarget("Eve", owner)).toBeNull();
    expect(normalizeSendTarget("owner", undefined)).toBeNull();
  });

  it("lowercases the name part of a dm: session key", () => {
    expect(normalizeSendTarget("dm:Alex", owner)).toEqual({ sessionKey: "dm:alex" });
    expect(normalizeSendTarget("dm:ALEX", owner)).toEqual({ sessionKey: "dm:alex" });
  });

  it("does not validate dm: keys against the owner (cron / fallback paths may reference former identities)", () => {
    expect(normalizeSendTarget("dm:eve", owner)).toEqual({ sessionKey: "dm:eve" });
  });

  it("returns channel keys unchanged (case preserved for chatId hashes)", () => {
    expect(normalizeSendTarget("imessage:any;+;ABC123DEF", owner)).toEqual({ sessionKey: "imessage:any;+;ABC123DEF" });
    expect(normalizeSendTarget("telegram:-1001234567", owner)).toEqual({ sessionKey: "telegram:-1001234567" });
  });

  it("canonicalizes a raw channel key that is one of the owner's DM handles (#203)", () => {
    expect(normalizeSendTarget("telegram:12345", owner)).toEqual({
      sessionKey: "dm:alex",
      identityName: "Alex",
      rawReplyTarget: { channelName: "telegram", chatId: "12345" },
    });
    expect(normalizeSendTarget("imessage:iMessage;-;+15551234567", owner)).toEqual({
      sessionKey: "dm:alex",
      identityName: "Alex",
      rawReplyTarget: { channelName: "imessage", chatId: "iMessage;-;+15551234567" },
    });
    // Formatting drift still canonicalizes.
    expect(normalizeSendTarget("imessage:SMS;-;+1 (555) 123-4567", owner)?.sessionKey).toBe("dm:alex");
    // Group GUIDs (";+;") never canonicalize, even if the identifier collided.
    expect(normalizeSendTarget("imessage:iMessage;+;+15551234567", owner)).toEqual({
      sessionKey: "imessage:iMessage;+;+15551234567",
    });
  });

  it("leaves other chats and groups raw", () => {
    expect(normalizeSendTarget("telegram:99999", owner)).toEqual({ sessionKey: "telegram:99999" });
    expect(normalizeSendTarget("imessage:12345", owner)).toEqual({ sessionKey: "imessage:12345" });
    expect(normalizeSendTarget("telegram:-1001234567", owner)).toEqual({ sessionKey: "telegram:-1001234567" });
  });
});
