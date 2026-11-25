import { describe, expect, it } from "vitest";
import { messageInputSchema } from "../src/web/protocol.js";

// What POST /api/v1/messages accepts. A staged file's rows are in
// web-file-uploads.test.ts; a quote at its length limit in web-reply-markers.test.ts.
const requestId = "00000000-0000-4000-8000-000000000000";
const upload = "a".repeat(32);

describe("messageInputSchema", () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    ["text alone", { text: "hi" }, true],
    ["no text and nothing attached", { text: "" }, false],
    ["only whitespace", { text: "   " }, false],
    ["an image with no text", { text: "", images: [upload] }, true],
    ["six images", { text: "x", images: Array(6).fill(upload) }, true],
    ["seven images", { text: "x", images: Array(7).fill(upload) }, false],
    ["an image named by a path, not an upload id", { text: "x", images: ["../etc/passwd"] }, false],
    ["a reaction, which carries no content of its own", { text: "", reply: { text: "hi", reaction: "love" } }, true],
    ["a reaction with text", { text: "and", reply: { text: "hi", reaction: "love" } }, false],
    ["a reply with no text", { text: "", reply: { text: "hi" } }, false],
    ["a reply with text", { text: "ok", reply: { text: "hi" } }, true],
    ["an unknown reaction", { text: "", reply: { text: "hi", reaction: "wow" } }, false],
  ])("%s", (_name, input, ok) => {
    expect(messageInputSchema.safeParse({ requestId, ...input }).success).toBe(ok);
  });
});
