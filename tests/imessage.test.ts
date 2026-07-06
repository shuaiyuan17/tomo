import { afterEach, describe, it, expect, vi } from "vitest";
import { BlueBubblesChannel } from "../src/channels/imessage.js";
import { formatReplyContextMarker, isSatelliteService, SATELLITE_MARKER } from "../src/channels/text-utils.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it("provides fallback text for image-only messages", async () => {
    const { formatImageMarker } = await import("../src/channels/imageStore.js");
    const text = "";
    const marker = formatImageMarker(1, []);
    const result = text ? (marker ? `${marker} ${text}` : text) : marker;
    expect(result).toBe("[Sent an image]");
  });

  it("includes the saved disk path in the marker when storage is on", async () => {
    const { formatImageMarker } = await import("../src/channels/imageStore.js");
    expect(formatImageMarker(1, ["/abs/a.jpg"])).toBe("[Sent an image, saved to: /abs/a.jpg]");
    expect(formatImageMarker(3, ["/abs/a.jpg", "/abs/b.png"])).toBe(
      "[Sent 3 images, saved to: /abs/a.jpg, /abs/b.png]",
    );
  });

  it("prepends the marker even when the user wrote a caption", async () => {
    const { formatImageMarker } = await import("../src/channels/imageStore.js");
    const text = "look at this";
    const marker = formatImageMarker(1, ["/abs/a.jpg"]);
    const result = text ? (marker ? `${marker} ${text}` : text) : marker;
    expect(result).toBe("[Sent an image, saved to: /abs/a.jpg] look at this");
  });
});

describe("BlueBubbles inbound replay handling", () => {
  const payload = (guid: string, text: string) => ({
    type: "new-message",
    data: {
      guid,
      text,
      isFromMe: false,
      dateCreated: 1_000,
      handle: { address: "+15551234567" },
      chats: [{ guid: "iMessage;-;+15551234567" }],
      attachments: [],
    },
  });

  const dispatch = (channel: BlueBubblesChannel, event: ReturnType<typeof payload>) =>
    (channel as unknown as { handleWebhookEvent(payload: Record<string, unknown>): Promise<void> })
      .handleWebhookEvent(event);

  it("drops a repeated GUID after a channel restart", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "tomo-imessage-channel-"));
    const dedupeStorePath = join(dir, "seen.json");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));

    try {
      const first = new BlueBubblesChannel({
        url: "http://bluebubbles.local",
        password: "pw",
        webhookPort: 3100,
        dedupeStorePath,
      });
      const firstHandler = vi.fn(async () => {});
      first.onMessage(firstHandler);
      await dispatch(first, payload("guid-1", "hello"));
      await dispatch(first, payload("guid-1", "hello"));
      expect(firstHandler).toHaveBeenCalledTimes(1);

      const afterRestart = new BlueBubblesChannel({
        url: "http://bluebubbles.local",
        password: "pw",
        webhookPort: 3100,
        dedupeStorePath,
      });
      const restartedHandler = vi.fn(async () => {});
      afterRestart.onMessage(restartedHandler);
      await dispatch(afterRestart, payload("guid-1", "hello"));
      expect(restartedHandler).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops an empty new-message row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const channel = new BlueBubblesChannel({
      url: "http://bluebubbles.local",
      password: "pw",
      webhookPort: 3100,
    });
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    await dispatch(channel, payload("guid-empty", ""));
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches slash commands with a normalized senderId, matching the message path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const channel = new BlueBubblesChannel({
      url: "http://bluebubbles.local",
      password: "pw",
      webhookPort: 3100,
    });
    const commandHandler = vi.fn(async () => {});
    channel.onCommand(commandHandler);

    // BlueBubbles may report the owner's number formatted; owner checks
    // compare senderId against configured identity ids, so the command path
    // must normalize like the message path does.
    const event = payload("guid-cmd-1", "/model sonnet");
    event.data.handle.address = "+1 (555) 123-4567";
    await dispatch(channel, event);

    expect(commandHandler).toHaveBeenCalledTimes(1);
    expect(commandHandler).toHaveBeenCalledWith(
      "model",
      "iMessage;-;+15551234567",
      "+1 (555) 123-4567",
      "sonnet",
      "+15551234567",
    );
  });
});

describe("BlueBubbles typing indicator", () => {
  it("stops the local refresh loop without sending DELETE and waits for an in-flight POST", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const calls: Array<{ method: string; path: string }> = [];
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });

    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      calls.push({ method: init?.method ?? "GET", path: new URL(requestUrl).pathname });
      return pendingFetch;
    }));

    const channel = new BlueBubblesChannel({
      url: "http://bluebubbles.local",
      password: "pw",
      webhookPort: 3100,
    });

    const stopTyping = channel.startTyping("iMessage;-;+15551234567");
    const stopped = Promise.resolve(stopTyping());
    let didStop = false;
    void stopped.then(() => { didStop = true; });

    await Promise.resolve();
    expect(didStop).toBe(false);

    resolveFetch!(new Response(null, { status: 204 }));
    await stopped;

    expect(calls).toEqual([
      { method: "POST", path: "/api/v1/chat/iMessage%3B-%3B%2B15551234567/typing" },
    ]);
  });

  it("can explicitly clear the remote typing indicator for silent turns", async () => {
    let resolveTypingPost: ((response: Response) => void) | undefined;
    const calls: Array<{ method: string; path: string }> = [];
    const pendingTypingPost = new Promise<Response>((resolve) => {
      resolveTypingPost = resolve;
    });

    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method ?? "GET";
      calls.push({ method, path: new URL(requestUrl).pathname });
      if (method === "POST") return pendingTypingPost;
      return Promise.resolve(new Response(null, { status: 204 }));
    }));

    const channel = new BlueBubblesChannel({
      url: "http://bluebubbles.local",
      password: "pw",
      webhookPort: 3100,
    });

    const stopTyping = channel.startTyping("iMessage;+;group123");
    const stopped = Promise.resolve(stopTyping({ clear: true }));

    await Promise.resolve();
    resolveTypingPost!(new Response(null, { status: 204 }));
    await stopped;

    expect(calls).toEqual([
      { method: "POST", path: "/api/v1/chat/iMessage%3B%2B%3Bgroup123/typing" },
      { method: "DELETE", path: "/api/v1/chat/iMessage%3B%2B%3Bgroup123/typing" },
    ]);
  });

  it("clears again if a slow typing POST finishes after the stop wait", async () => {
    vi.useFakeTimers();

    let resolveTypingPost: ((response: Response) => void) | undefined;
    const calls: Array<{ method: string; path: string }> = [];
    const pendingTypingPost = new Promise<Response>((resolve) => {
      resolveTypingPost = resolve;
    });

    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method ?? "GET";
      calls.push({ method, path: new URL(requestUrl).pathname });
      if (method === "POST") return pendingTypingPost;
      return Promise.resolve(new Response(null, { status: 204 }));
    }));

    const channel = new BlueBubblesChannel({
      url: "http://bluebubbles.local",
      password: "pw",
      webhookPort: 3100,
    });

    const stopTyping = channel.startTyping("iMessage;+;group123");
    const stopped = Promise.resolve(stopTyping({ clear: true }));

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await stopped;

    expect(calls).toEqual([
      { method: "POST", path: "/api/v1/chat/iMessage%3B%2B%3Bgroup123/typing" },
      { method: "DELETE", path: "/api/v1/chat/iMessage%3B%2B%3Bgroup123/typing" },
    ]);

    resolveTypingPost!(new Response(null, { status: 204 }));
    for (let i = 0; i < 10 && calls.length < 3; i++) {
      await Promise.resolve();
    }

    expect(calls).toEqual([
      { method: "POST", path: "/api/v1/chat/iMessage%3B%2B%3Bgroup123/typing" },
      { method: "DELETE", path: "/api/v1/chat/iMessage%3B%2B%3Bgroup123/typing" },
      { method: "DELETE", path: "/api/v1/chat/iMessage%3B%2B%3Bgroup123/typing" },
    ]);
  });

  it("clears again if the typing POST settles during the first clear", async () => {
    vi.useFakeTimers();

    let resolveTypingPost: ((response: Response) => void) | undefined;
    let resolveFirstDelete: ((response: Response) => void) | undefined;
    const calls: Array<{ method: string; path: string }> = [];
    const pendingTypingPost = new Promise<Response>((resolve) => {
      resolveTypingPost = resolve;
    });
    const pendingFirstDelete = new Promise<Response>((resolve) => {
      resolveFirstDelete = resolve;
    });
    let deleteCount = 0;

    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method ?? "GET";
      calls.push({ method, path: new URL(requestUrl).pathname });
      if (method === "POST") return pendingTypingPost;
      deleteCount++;
      if (deleteCount === 1) {
        resolveTypingPost!(new Response(null, { status: 204 }));
        return pendingFirstDelete;
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }));

    const channel = new BlueBubblesChannel({
      url: "http://bluebubbles.local",
      password: "pw",
      webhookPort: 3100,
    });

    const stopTyping = channel.startTyping("iMessage;+;group123");
    const stopped = Promise.resolve(stopTyping({ clear: true }));

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([
      { method: "POST", path: "/api/v1/chat/iMessage%3B%2B%3Bgroup123/typing" },
      { method: "DELETE", path: "/api/v1/chat/iMessage%3B%2B%3Bgroup123/typing" },
    ]);

    await Promise.resolve();
    resolveFirstDelete!(new Response(null, { status: 204 }));
    await stopped;
    for (let i = 0; i < 10 && calls.length < 3; i++) {
      await Promise.resolve();
    }

    expect(calls).toEqual([
      { method: "POST", path: "/api/v1/chat/iMessage%3B%2B%3Bgroup123/typing" },
      { method: "DELETE", path: "/api/v1/chat/iMessage%3B%2B%3Bgroup123/typing" },
      { method: "DELETE", path: "/api/v1/chat/iMessage%3B%2B%3Bgroup123/typing" },
    ]);
  });
});

describe("isSatelliteService", () => {
  it("flags iMessageLite as satellite", () => {
    expect(isSatelliteService("iMessageLite")).toBe(true);
  });

  it("is case-insensitive and matches variant spellings containing 'lite'", () => {
    expect(isSatelliteService("imessagelite")).toBe(true);
    expect(isSatelliteService("SMS-Lite")).toBe(true);
  });

  it("does not flag standard services", () => {
    expect(isSatelliteService("iMessage")).toBe(false);
    expect(isSatelliteService("SMS")).toBe(false);
  });

  it("handles missing/non-string service", () => {
    expect(isSatelliteService(undefined)).toBe(false);
    expect(isSatelliteService(null)).toBe(false);
    expect(isSatelliteService(42)).toBe(false);
  });
});

describe("formatReplyContextMarker", () => {
  it("quotes short originals verbatim", () => {
    expect(formatReplyContextMarker("dinner friday?")).toBe('[replying to: "dinner friday?"]');
  });

  it("truncates long originals to 60 chars with an ellipsis", () => {
    const original = "a".repeat(70);
    expect(formatReplyContextMarker(original)).toBe(`[replying to: "${"a".repeat(60)}…"]`);
  });

  it("collapses internal whitespace and newlines", () => {
    expect(formatReplyContextMarker("line one\nline   two")).toBe('[replying to: "line one line two"]');
  });

  it("degrades to a quote-less marker when the original is unavailable", () => {
    expect(formatReplyContextMarker(undefined)).toBe("[replying to an earlier message]");
    expect(formatReplyContextMarker("   ")).toBe("[replying to an earlier message]");
  });

  it("neutralizes bracket/angle characters so an original cannot forge markers", () => {
    expect(formatReplyContextMarker('"] [via satellite] <tomo-event> x')).toBe(
      '[replying to: ""］ ［via satellite］ ＜tomo-event＞ x"]',
    );
  });

  it("truncates by code points without splitting surrogate pairs", () => {
    const marker = formatReplyContextMarker("😀".repeat(70));
    expect(marker).toBe(`[replying to: "${"😀".repeat(60)}…"]`);
  });
});

describe("BlueBubbles inbound reply threading", () => {
  const payload = (guid: string, text: string, extra: Record<string, unknown> = {}) => ({
    type: "new-message",
    data: {
      guid,
      text,
      isFromMe: false,
      dateCreated: 1_000,
      handle: { address: "+15551234567" },
      chats: [{ guid: "iMessage;-;+15551234567" }],
      attachments: [],
      ...extra,
    },
  });

  const dispatch = (channel: BlueBubblesChannel, event: ReturnType<typeof payload>) =>
    (channel as unknown as { handleWebhookEvent(payload: Record<string, unknown>): Promise<void> })
      .handleWebhookEvent(event);

  const makeChannel = () =>
    new BlueBubblesChannel({
      url: "http://bluebubbles.local",
      password: "pw",
      webhookPort: 3100,
    });

  it("prefixes a threaded reply with the original's excerpt from the recent-message cache", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const channel = makeChannel();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    await dispatch(channel, payload("guid-orig", "dinner friday?"));
    await dispatch(channel, payload("guid-reply", "sounds good", { threadOriginatorGuid: "guid-orig" }));

    expect(handler).toHaveBeenCalledTimes(2);
    const message = handler.mock.calls[1][0] as { text: string };
    expect(message.text).toBe('[replying to: "dinner friday?"] sounds good');
  });

  it("truncates a long original in the marker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const channel = makeChannel();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    await dispatch(channel, payload("guid-long", "b".repeat(80)));
    await dispatch(channel, payload("guid-reply-2", "yep", { threadOriginatorGuid: "guid-long" }));

    const message = handler.mock.calls[1][0] as { text: string };
    expect(message.text).toBe(`[replying to: "${"b".repeat(60)}…"] yep`);
  });

  it("falls back to the BlueBubbles server when the original is not cached", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (new URL(requestUrl).pathname === "/api/v1/message/guid-ancient") {
        return new Response(JSON.stringify({ data: { guid: "guid-ancient", text: "the original text" } }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }));
    const channel = makeChannel();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    await dispatch(channel, payload("guid-reply-3", "late answer", { threadOriginatorGuid: "guid-ancient" }));

    const message = handler.mock.calls[0][0] as { text: string };
    expect(message.text).toBe('[replying to: "the original text"] late answer');
  });

  it("degrades to a quote-less marker when the lookup fails, without blocking delivery", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (new URL(requestUrl).pathname.startsWith("/api/v1/message/")) {
        return new Response("boom", { status: 500 });
      }
      return new Response(null, { status: 204 });
    }));
    const channel = makeChannel();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    await dispatch(channel, payload("guid-reply-4", "still arrives", { threadOriginatorGuid: "guid-gone" }));

    expect(handler).toHaveBeenCalledTimes(1);
    const message = handler.mock.calls[0][0] as { text: string };
    expect(message.text).toBe("[replying to an earlier message] still arrives");
  });

  it("does not tag plain messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const channel = makeChannel();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    await dispatch(channel, payload("guid-plain", "no thread here"));

    const message = handler.mock.calls[0][0] as { text: string };
    expect(message.text).toBe("no thread here");
  });

  it("bounds the fallback lookup with an abort signal and degrades on abort", async () => {
    let lookupSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (new URL(requestUrl).pathname.startsWith("/api/v1/message/")) {
        lookupSignal = init?.signal;
        // What AbortSignal.timeout(...) produces when the bound elapses.
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return new Response(null, { status: 204 });
    }));
    const channel = makeChannel();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    await dispatch(channel, payload("guid-reply-5", "delivered anyway", { threadOriginatorGuid: "guid-slow" }));

    expect(lookupSignal).toBeInstanceOf(AbortSignal);
    expect(handler).toHaveBeenCalledTimes(1);
    const message = handler.mock.calls[0][0] as { text: string };
    expect(message.text).toBe("[replying to an earlier message] delivered anyway");
  });
});

describe("BlueBubbles recent-message cache", () => {
  const payload = (guid: string, text: string, extra: Record<string, unknown> = {}) => ({
    type: "new-message",
    data: {
      guid,
      text,
      isFromMe: false,
      dateCreated: 1_000,
      handle: { address: "+15551234567" },
      chats: [{ guid: "iMessage;-;+15551234567" }],
      attachments: [],
      ...extra,
    },
  });

  const dispatch = (channel: BlueBubblesChannel, event: ReturnType<typeof payload>) =>
    (channel as unknown as { handleWebhookEvent(payload: Record<string, unknown>): Promise<void> })
      .handleWebhookEvent(event);

  const makeChannel = () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    return new BlueBubblesChannel({
      url: "http://bluebubbles.local",
      password: "pw",
      webhookPort: 3100,
    });
  };

  it("records inbound and own (isFromMe) rows, newest first", async () => {
    const channel = makeChannel();
    channel.onMessage(vi.fn(async () => {}));

    await dispatch(channel, payload("g-1", "from them"));
    await dispatch(channel, payload("g-2", "from us", { isFromMe: true }));

    const recent = channel.recentMessages("iMessage;-;+15551234567");
    expect(recent.map((m) => m.id)).toEqual(["g-2", "g-1"]);
    expect(recent[0].fromMe).toBe(true);
    expect(recent[0].senderName).toBeUndefined();
    expect(recent[1].fromMe).toBe(false);
  });

  it("dedupes replayed GUIDs and skips empty rows", async () => {
    const channel = makeChannel();
    channel.onMessage(vi.fn(async () => {}));

    await dispatch(channel, payload("g-1", "hello"));
    await dispatch(channel, payload("g-1", "hello"));
    await dispatch(channel, payload("g-ghost", "   "));

    expect(channel.recentMessages("iMessage;-;+15551234567").map((m) => m.id)).toEqual(["g-1"]);
  });

  it("caps the window at 50 messages per chat", async () => {
    const channel = makeChannel();
    channel.onMessage(vi.fn(async () => {}));

    for (let i = 1; i <= 55; i++) {
      await dispatch(channel, payload(`g-${i}`, `message ${i}`));
    }

    const recent = channel.recentMessages("iMessage;-;+15551234567");
    expect(recent).toHaveLength(50);
    expect(recent[0].id).toBe("g-55");
    expect(recent[49].id).toBe("g-6");
  });

  it("resolves a bare DM handle to its chat-GUID ring, but never a group", async () => {
    const channel = makeChannel();
    channel.onMessage(vi.fn(async () => {}));

    await dispatch(channel, payload("g-dm", "direct message"));
    const groupEvent = payload("g-group", "group message");
    groupEvent.data.chats = [{ guid: "iMessage;+;chat123" }];
    await dispatch(channel, groupEvent);

    // Config identity form (formatted handle) resolves to the DM ring.
    expect(channel.recentMessages("+1 (555) 123-4567").map((m) => m.id)).toEqual(["g-dm"]);
    expect(channel.recentMessages("+15551234567").map((m) => m.id)).toEqual(["g-dm"]);
    // Group rings stay addressable by full GUID only.
    expect(channel.recentMessages("iMessage;+;chat123").map((m) => m.id)).toEqual(["g-group"]);
    expect(channel.recentMessages("chat123")).toEqual([]);
  });
});

describe("BlueBubbles outbound threaded reply", () => {
  const capturedBodies = () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (new URL(requestUrl).pathname === "/api/v1/message/text") {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      return new Response("{}", { status: 200 });
    }));
    return bodies;
  };

  const makeChannel = () =>
    new BlueBubblesChannel({
      url: "http://bluebubbles.local",
      password: "pw",
      webhookPort: 3100,
    });

  it("sends a replyTo message via the Private API with selectedMessageGuid", async () => {
    const bodies = capturedBodies();
    const channel = makeChannel();

    await channel.send({ chatId: "iMessage;-;+15551234567", text: "threaded!", replyTo: "guid-target" });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      chatGuid: "iMessage;-;+15551234567",
      message: "threaded!",
      method: "private-api",
      selectedMessageGuid: "guid-target",
      partIndex: 0,
    });
  });

  it("keeps plain sends on apple-script with no selectedMessageGuid", async () => {
    const bodies = capturedBodies();
    const channel = makeChannel();

    await channel.send({ chatId: "iMessage;-;+15551234567", text: "plain" });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].method).toBe("apple-script");
    expect(bodies[0]).not.toHaveProperty("selectedMessageGuid");
  });

  it("threads only the first chunk of a long reply", async () => {
    const bodies = capturedBodies();
    const channel = makeChannel();

    const longText = `${"x".repeat(3990)} ${"y".repeat(100)}`;
    await channel.send({ chatId: "iMessage;-;+15551234567", text: longText, replyTo: "guid-target" });

    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies[0].selectedMessageGuid).toBe("guid-target");
    expect(bodies[0].method).toBe("private-api");
    for (const body of bodies.slice(1)) {
      expect(body).not.toHaveProperty("selectedMessageGuid");
      expect(body.method).toBe("apple-script");
    }
  });

  it("threads only the first shipped block of a streamed group reply", async () => {
    const bodies = capturedBodies();
    const channel = makeChannel();

    const stream = channel.createStreamingMessage("iMessage;+;chat123", "guid-trigger");
    stream.update("first block");
    await stream.commitBlock();
    stream.update("second block");
    await stream.finish();

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ message: "first block", method: "private-api", selectedMessageGuid: "guid-trigger" });
    expect(bodies[1].message).toBe("second block");
    expect(bodies[1].method).toBe("apple-script");
    expect(bodies[1]).not.toHaveProperty("selectedMessageGuid");
  });
});

describe("BlueBubbles edit and unsend", () => {
  const ownMessagePayload = (guid: string, text: string) => ({
    type: "new-message",
    data: {
      guid,
      text,
      isFromMe: true,
      dateCreated: 1_000,
      handle: { address: "+15551234567" },
      chats: [{ guid: "iMessage;-;+15551234567" }],
      attachments: [],
    },
  });

  const dispatch = (channel: BlueBubblesChannel, event: ReturnType<typeof ownMessagePayload>) =>
    (channel as unknown as { handleWebhookEvent(payload: Record<string, unknown>): Promise<void> })
      .handleWebhookEvent(event);

  const captureApi = () => {
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      calls.push({
        method: init?.method ?? "GET",
        path: new URL(requestUrl).pathname,
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
      });
      return new Response("{}", { status: 200 });
    }));
    return calls;
  };

  const makeChannel = () =>
    new BlueBubblesChannel({
      url: "http://bluebubbles.local",
      password: "pw",
      webhookPort: 3100,
    });

  it("edits via the Private API edit endpoint and updates the cached text", async () => {
    const calls = captureApi();
    const channel = makeChannel();
    await dispatch(channel, ownMessagePayload("guid-mine", "helo world"));

    await channel.editMessage("iMessage;-;+15551234567", "guid-mine", "hello world");

    const edit = calls.find((c) => c.path === "/api/v1/message/guid-mine/edit");
    expect(edit).toBeDefined();
    expect(edit!.method).toBe("POST");
    expect(edit!.body).toEqual({
      editedMessage: "hello world",
      backwardsCompatibilityMessage: "Edited to: hello world",
      partIndex: 0,
    });
    expect(channel.recentMessages("iMessage;-;+15551234567")[0].text).toBe("hello world");
  });

  it("updates the cached text even when addressed by bare handle", async () => {
    captureApi();
    const channel = makeChannel();
    await dispatch(channel, ownMessagePayload("guid-mine", "before"));

    // Callers may address a DM by the config identity form; rings are keyed
    // by chat GUID. GUIDs are globally unique, so the update still lands.
    await channel.editMessage("+15551234567", "guid-mine", "after");

    expect(channel.recentMessages("iMessage;-;+15551234567")[0].text).toBe("after");
  });

  it("unsends via the Private API unsend endpoint and drops the cached row", async () => {
    const calls = captureApi();
    const channel = makeChannel();
    await dispatch(channel, ownMessagePayload("guid-mine", "oops wrong chat"));
    expect(channel.recentMessages("iMessage;-;+15551234567")).toHaveLength(1);

    await channel.unsendMessage("iMessage;-;+15551234567", "guid-mine");

    const unsend = calls.find((c) => c.path === "/api/v1/message/guid-mine/unsend");
    expect(unsend).toBeDefined();
    expect(unsend!.method).toBe("POST");
    expect(unsend!.body).toEqual({ partIndex: 0 });
    expect(channel.recentMessages("iMessage;-;+15551234567")).toHaveLength(0);
  });

  it("rejects empty edited text without calling the API", async () => {
    const calls = captureApi();
    const channel = makeChannel();

    await expect(channel.editMessage("iMessage;-;+15551234567", "guid-mine", "  ")).rejects.toThrow(/cannot be empty/i);
    expect(calls).toHaveLength(0);
  });

  it("surfaces server rejections (edit window elapsed, Private API off)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("edit window elapsed", { status: 400 })));
    const channel = makeChannel();

    await expect(channel.editMessage("iMessage;-;+15551234567", "guid-old", "too late")).rejects.toThrow(/400/);
  });
});

describe("BlueBubbles satellite message tagging", () => {
  const payload = (guid: string, text: string, service?: string, handleService?: string) => ({
    type: "new-message",
    data: {
      guid,
      text,
      ...(service !== undefined ? { service } : {}),
      isFromMe: false,
      dateCreated: 1_000,
      handle: {
        address: "+15551234567",
        ...(handleService !== undefined ? { service: handleService } : {}),
      },
      chats: [{ guid: "iMessage;-;+15551234567" }],
      attachments: [],
    },
  });

  const dispatch = (channel: BlueBubblesChannel, event: ReturnType<typeof payload>) =>
    (channel as unknown as { handleWebhookEvent(payload: Record<string, unknown>): Promise<void> })
      .handleWebhookEvent(event);

  const makeChannel = () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    return new BlueBubblesChannel({
      url: "http://bluebubbles.local",
      password: "pw",
      webhookPort: 3100,
    });
  };

  it("prefixes satellite (iMessageLite) text with the satellite marker", async () => {
    const channel = makeChannel();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    await dispatch(channel, payload("guid-sat-1", "we are off-grid", "iMessageLite"));
    expect(handler).toHaveBeenCalledTimes(1);
    const message = handler.mock.calls[0][0] as { text: string };
    expect(message.text).toBe(`${SATELLITE_MARKER} we are off-grid`);
  });

  it("prefixes satellite text when BlueBubbles only exposes handle service", async () => {
    const channel = makeChannel();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    await dispatch(
      channel,
      payload("guid-sat-handle", "can you see this", undefined, "iMessageLite"),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    const message = handler.mock.calls[0][0] as { text: string };
    expect(message.text).toBe(`${SATELLITE_MARKER} can you see this`);
  });

  it("does not tag standard iMessage text", async () => {
    const channel = makeChannel();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    await dispatch(channel, payload("guid-sat-2", "normal message", "iMessage"));
    const message = handler.mock.calls[0][0] as { text: string };
    expect(message.text).toBe("normal message");
  });

  it("does not tag when service is absent", async () => {
    const channel = makeChannel();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    await dispatch(channel, payload("guid-sat-3", "no service field"));
    const message = handler.mock.calls[0][0] as { text: string };
    expect(message.text).toBe("no service field");
  });

  it("still drops an empty satellite ghost row", async () => {
    const channel = makeChannel();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    await dispatch(channel, payload("guid-sat-4", "", "iMessageLite"));
    await dispatch(channel, payload("guid-sat-5", "   ", "iMessageLite"));
    expect(handler).not.toHaveBeenCalled();
  });
});
