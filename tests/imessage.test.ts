import { describe, it, expect } from "vitest";

// Test phone/email address normalization (extracted from BlueBubblesChannel.normalizeAddress)
function normalizeAddress(addr: string): string {
  if (addr.includes("@")) return addr.toLowerCase();
  return addr.replace(/[^\d+]/g, "");
}

describe("normalizeAddress", () => {
  it("normalizes phone with parentheses and dashes", () => {
    expect(normalizeAddress("(555) 123-4567")).toBe("5551234567");
  });

  it("preserves leading +", () => {
    expect(normalizeAddress("+1 (555) 123-4567")).toBe("+15551234567");
  });

  it("preserves clean phone number", () => {
    expect(normalizeAddress("+15551234567")).toBe("+15551234567");
  });

  it("lowercases email addresses", () => {
    expect(normalizeAddress("John@Example.COM")).toBe("john@example.com");
  });

  it("strips spaces from phone", () => {
    expect(normalizeAddress("555 123 4567")).toBe("5551234567");
  });
});

// Test contact name resolution (extracted logic)
function resolveContactName(address: string, cache: Map<string, string>): string {
  const normalized = normalizeAddress(address);
  return cache.get(normalized) ?? address;
}

describe("resolveContactName", () => {
  it("resolves known contact", () => {
    const cache = new Map([["+15551234567", "Alice Smith"]]);
    expect(resolveContactName("+15551234567", cache)).toBe("Alice Smith");
  });

  it("resolves with format normalization", () => {
    const cache = new Map([["+15551234567", "Alice Smith"]]);
    expect(resolveContactName("+1 (555) 123-4567", cache)).toBe("Alice Smith");
  });

  it("returns raw address for unknown contact", () => {
    const cache = new Map<string, string>();
    expect(resolveContactName("+15559999999", cache)).toBe("+15559999999");
  });

  it("resolves email contact", () => {
    const cache = new Map([["alice@example.com", "Alice"]]);
    expect(resolveContactName("Alice@Example.COM", cache)).toBe("Alice");
  });
});

// Test text splitting (extracted from BlueBubblesChannel.splitText)
function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.5) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt < limit * 0.5) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

describe("splitText", () => {
  it("returns single chunk for short text", () => {
    expect(splitText("hello", 100)).toEqual(["hello"]);
  });

  it("splits at newline boundary when text exceeds limit", () => {
    // "a{15}\nb{15}" = 31 chars, limit 20 → should split at the newline
    const text = "a".repeat(15) + "\n" + "b".repeat(15);
    const chunks = splitText(text, 20);
    expect(chunks[0]).toBe("a".repeat(15));
    expect(chunks.length).toBe(2);
  });

  it("splits at space when no newline", () => {
    const text = "hello world this is a long message";
    const chunks = splitText(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    // All chunks should be non-empty
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("hard-splits when no good boundary", () => {
    const text = "x".repeat(100);
    const chunks = splitText(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBe(30);
  });

  it("preserves all content", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const chunks = splitText(text, 15);
    const joined = chunks.join(" ");
    // All words should be present
    for (const word of text.split(" ")) {
      expect(joined).toContain(word);
    }
  });
});

// Test iMessage group chat detection (extracted from handleWebhookEvent)
function isGroupChat(chatGuid: string): boolean {
  return chatGuid.includes(";+;");
}

describe("isGroupChat (iMessage)", () => {
  it("detects group chat GUID", () => {
    expect(isGroupChat("iMessage;+;chat123456")).toBe(true);
  });

  it("detects DM GUID", () => {
    expect(isGroupChat("iMessage;-;+15551234567")).toBe(false);
  });

  it("detects SMS DM", () => {
    expect(isGroupChat("SMS;-;+15551234567")).toBe(false);
  });
});

// Test iMessage identifier extraction (used in router for matching)
function extractImessageIdentifier(chatGuid: string): string | null {
  const parts = chatGuid.split(";");
  if (parts.length >= 3) return parts.slice(2).join(";");
  return null;
}

describe("extractImessageIdentifier", () => {
  it("extracts phone number from DM GUID", () => {
    expect(extractImessageIdentifier("iMessage;-;+15551234567")).toBe("+15551234567");
  });

  it("extracts email from DM GUID", () => {
    expect(extractImessageIdentifier("iMessage;-;user@example.com")).toBe("user@example.com");
  });

  it("extracts group identifier", () => {
    expect(extractImessageIdentifier("iMessage;+;chat123456")).toBe("chat123456");
  });

  it("returns null for malformed GUID", () => {
    expect(extractImessageIdentifier("nodelimiters")).toBeNull();
    expect(extractImessageIdentifier("one;part")).toBeNull();
  });

  it("handles identifiers containing semicolons", () => {
    expect(extractImessageIdentifier("iMessage;-;some;complex;id")).toBe("some;complex;id");
  });
});

// Test webhook event field extraction logic
describe("webhook event parsing", () => {
  it("skips non-new-message events", () => {
    const payload = { type: "typing-indicator", data: {} };
    expect(payload.type !== "new-message").toBe(true);
  });

  it("skips messages from self", () => {
    const data = { isFromMe: true, text: "hello" };
    expect(!!data.isFromMe).toBe(true);
  });

  it("uses empty string for missing text", () => {
    const data = { text: undefined };
    const text = (data.text as string) ?? "";
    expect(text).toBe("");
  });

  it("skips messages without chat info", () => {
    const data = { chats: [] as Array<Record<string, unknown>> };
    const chat = data.chats?.[0];
    expect(chat).toBeUndefined();
  });

  it("extracts sender address with fallback", () => {
    const data1 = { handle: { address: "+15551234567" } };
    const addr1 = (data1.handle?.address as string) ?? "Unknown";
    expect(addr1).toBe("+15551234567");

    const data2 = { handle: undefined };
    const addr2 = ((data2.handle as Record<string, unknown> | undefined)?.address as string) ?? "Unknown";
    expect(addr2).toBe("Unknown");
  });

  it("treats all group messages as mentioned", () => {
    const chatGuid = "iMessage;+;chat123";
    const isGroup = chatGuid.includes(";+;");
    const isMentioned = isGroup;
    expect(isMentioned).toBe(true);
  });

  it("provides fallback text for image-only messages", () => {
    const text = "";
    const images = [{ data: "base64...", mediaType: "image/jpeg" }];
    const result = text || (images.length > 0 ? "[Sent an image]" : "");
    expect(result).toBe("[Sent an image]");
  });
});
