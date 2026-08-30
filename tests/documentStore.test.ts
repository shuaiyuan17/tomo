import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub the logger so the intentionally-failing "bad baseDir" test doesn't
// flush a real ERROR line to stderr. Same pattern as imageStore.test.ts.
vi.mock("../src/logger.js", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const {
  buildDocumentPath,
  documentMimeToExt,
  formatDocumentMarker,
  isSupportedDocumentMime,
  readBodyWithCap,
  saveInboundDocument,
  MAX_DOCUMENT_BYTES,
} = await import("../src/channels/documentStore.js");

describe("documentMimeToExt", () => {
  it("maps PDF and common text formats", () => {
    expect(documentMimeToExt("application/pdf")).toBe("pdf");
    expect(documentMimeToExt("text/plain")).toBe("txt");
    expect(documentMimeToExt("text/markdown")).toBe("md");
    expect(documentMimeToExt("text/csv")).toBe("csv");
    expect(documentMimeToExt("application/json")).toBe("json");
  });

  it("falls back to subtype for unknown application/* and text/*", () => {
    expect(documentMimeToExt("application/xml")).toBe("xml");
    expect(documentMimeToExt("text/yaml")).toBe("yaml");
  });

  it("returns bin for unsupported families or missing", () => {
    expect(documentMimeToExt(undefined)).toBe("bin");
    expect(documentMimeToExt("image/png")).toBe("bin");
    expect(documentMimeToExt("video/mp4")).toBe("bin");
  });
});

describe("isSupportedDocumentMime", () => {
  it("accepts application/pdf (case-insensitive)", () => {
    expect(isSupportedDocumentMime("application/pdf")).toBe(true);
    expect(isSupportedDocumentMime("APPLICATION/PDF")).toBe(true);
  });

  it("rejects images and other types", () => {
    expect(isSupportedDocumentMime("image/png")).toBe(false);
    expect(isSupportedDocumentMime("text/plain")).toBe(false);
    expect(isSupportedDocumentMime(undefined)).toBe(false);
  });
});

describe("formatDocumentMarker", () => {
  it("returns empty string for zero docs", () => {
    expect(formatDocumentMarker(0, [])).toBe("");
  });

  it("singular vs plural", () => {
    expect(formatDocumentMarker(1, [])).toBe("[Sent a document]");
    expect(formatDocumentMarker(3, [])).toBe("[Sent 3 documents]");
  });

  it("appends saved paths when present", () => {
    expect(formatDocumentMarker(1, ["/tmp/foo.pdf"])).toBe(
      "[Sent a document, saved to: /tmp/foo.pdf]",
    );
    expect(formatDocumentMarker(2, ["/tmp/a.pdf", "/tmp/b.pdf"])).toBe(
      "[Sent 2 documents, saved to: /tmp/a.pdf, /tmp/b.pdf]",
    );
  });

  it("falls back to no-paths form when intended > saved", () => {
    expect(formatDocumentMarker(2, [])).toBe("[Sent 2 documents]");
  });
});

describe("buildDocumentPath", () => {
  it("composes a date-folder path with timestamp + session + guid + ext", () => {
    const ts = new Date(2026, 4, 5, 22, 33, 7); // local time
    const result = buildDocumentPath("/base", "application/pdf", {
      sessionKey: "imessage_dm",
      guid: "abcdef1234567890",
      timestamp: ts,
    });
    expect(result.dir).toBe("/base/memory/incoming-documents/2026-05-05");
    expect(result.filename).toMatch(/^223307_imessage_dm_abcdef12\.pdf$/);
  });

  it("includes the sanitized filename stem when provided", () => {
    const ts = new Date(2026, 4, 5, 9, 1, 2);
    const result = buildDocumentPath("/base", "application/pdf", {
      sessionKey: "tg",
      guid: "g123",
      filename: "Lab Results — May 2026.pdf",
      timestamp: ts,
    });
    // Hyphen char (—) should be replaced with underscore
    expect(result.filename).toBe("090102_tg_g123_Lab_Results___May_2026.pdf");
  });

  it("sanitizes session and guid characters", () => {
    const ts = new Date(2026, 4, 5, 0, 0, 0);
    const result = buildDocumentPath("/base", "application/pdf", {
      sessionKey: "weird/session!",
      guid: "x".repeat(40),
      timestamp: ts,
    });
    expect(result.filename).toMatch(/^000000_weird_session__/);
    // Truncated to 8 chars
    expect(result.filename).toContain("xxxxxxxx.pdf");
  });

  it("handles missing meta fields with fallbacks", () => {
    const ts = new Date(2026, 4, 5, 0, 0, 0);
    const result = buildDocumentPath("/base", "application/pdf", { timestamp: ts });
    expect(result.filename).toBe("000000_session_unknown.pdf");
  });
});

describe("saveInboundDocument", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "tomo-doc-test-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("writes the buffer and returns the path", async () => {
    const ts = new Date(2026, 4, 5, 12, 34, 56);
    const buffer = Buffer.from("%PDF-1.4 fake pdf bytes");
    const fullPath = await saveInboundDocument(
      buffer,
      "application/pdf",
      { sessionKey: "dm", guid: "g00", timestamp: ts, filename: "report.pdf" },
      baseDir,
    );
    expect(fullPath).not.toBeNull();
    expect(fullPath!.startsWith(baseDir)).toBe(true);
    const written = await readFile(fullPath!);
    expect(written.equals(buffer)).toBe(true);

    // Verify the path layout
    const st = await stat(fullPath!);
    expect(st.size).toBe(buffer.length);
  });

  it("never overwrites: two documents with the same computed name both survive", async () => {
    // Telegram forwards two PDFs named the same thing in the same second, or
    // the guid prefix collides — either way `buildDocumentPath` produces one
    // path for both, and a plain write would leave one file on disk while
    // reporting two saved.
    const ts = new Date(2026, 7, 30, 9, 15, 0);
    const meta = { sessionKey: "dm", guid: "abc12345-aaaa", timestamp: ts, filename: "report.pdf" };

    const a = await saveInboundDocument(Buffer.from("first pdf"), "application/pdf", meta, baseDir);
    const b = await saveInboundDocument(Buffer.from("second pdf"), "application/pdf", meta, baseDir);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b).not.toBe(a);
    expect((await readFile(a!)).toString()).toBe("first pdf");
    expect((await readFile(b!)).toString()).toBe("second pdf");
    expect(b!.endsWith("_report-1.pdf")).toBe(true);
  });

  it("returns null and does not throw on bad baseDir (parent unwritable)", async () => {
    // Use a path under /dev/null (a non-directory) so mkdir fails immediately
    // with ENOTDIR on both macOS and Linux. This avoids slow probe paths in
    // CI that caused the previous /proc-based path to hit the test timeout.
    const bogus = "/dev/null/\0invalid";
    const result = await saveInboundDocument(
      Buffer.from("x"),
      "application/pdf",
      { sessionKey: "dm", guid: "g" },
      bogus,
    );
    expect(result).toBeNull();
  });
});

describe("MAX_DOCUMENT_BYTES", () => {
  it("matches Anthropic's 32 MB PDF cap", () => {
    expect(MAX_DOCUMENT_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe("readBodyWithCap", () => {
  // Build a Response whose body is a ReadableStream emitting `chunks` in order.
  function streamResponse(chunks: Uint8Array[]): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    return new Response(stream);
  }

  it("returns the buffer when total size is within cap", async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const buf = await readBodyWithCap(streamResponse(chunks), 100);
    expect(buf).not.toBeNull();
    expect(buf!.length).toBe(5);
    expect(Array.from(buf!)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns null and stops reading when cap is exceeded mid-stream", async () => {
    let secondChunkRead = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        // Schedule a second chunk; if cap-cancellation works, this enqueue
        // happens but the reader is already cancelled.
        controller.enqueue(new Uint8Array(20));
        secondChunkRead = true;
        controller.close();
      },
    });
    const res = new Response(stream);
    const buf = await readBodyWithCap(res, 5);
    expect(buf).toBeNull();
    // The second-chunk enqueue does happen at start time; what we really
    // assert is the cap-hit returns null without throwing or buffering past
    // the cap. The flag just confirms the start callback ran.
    expect(secondChunkRead).toBe(true);
  });

  it("falls back to arrayBuffer + post-check when body is missing", async () => {
    // A Response with no body (e.g. some 204-style edge cases). We construct
    // one by passing null body, then patch arrayBuffer to return a small
    // payload — verifying we still get a Buffer back.
    const res = new Response(null);
    Object.defineProperty(res, "body", { value: null });
    res.arrayBuffer = async () => new Uint8Array([7, 8, 9]).buffer;
    const buf = await readBodyWithCap(res, 100);
    expect(buf).not.toBeNull();
    expect(Array.from(buf!)).toEqual([7, 8, 9]);
  });

  it("falls back path also enforces cap via post-check", async () => {
    const res = new Response(null);
    Object.defineProperty(res, "body", { value: null });
    res.arrayBuffer = async () => new Uint8Array(20).buffer;
    const buf = await readBodyWithCap(res, 5);
    expect(buf).toBeNull();
  });
});
