import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { LOG_REDACT_PATHS, isSecretFieldName, redactSecretValue, redactSecrets } from "../src/redact.js";

// A token shaped like a real Telegram one. Long enough that `***` + last four
// is meaningfully different from the whole thing.
const TOKEN = "8123456:AAH-not-a-real-bot-token-9xQz";

describe("redactSecrets", () => {
  it("redacts credential-shaped field names and leaves the rest verbatim", () => {
    expect(redactSecrets({ token: TOKEN, allowlist: "123456789" })).toEqual({
      token: "***9xQz",
      allowlist: "123456789",
    });
    expect(redactSecrets({ litellm: { baseUrl: "http://x", apiKey: "sk-abcdef" } })).toEqual({
      litellm: { baseUrl: "http://x", apiKey: "***cdef" },
    });
  });

  it("keeps routing identifiers readable", () => {
    // The whole point of a log line is usually the session it happened in.
    for (const name of ["key", "sessionKey", "storeKey", "channelKey", "chatKey", "keyword"]) {
      expect(isSecretFieldName(name)).toBe(false);
    }
    for (const name of ["token", "apiKey", "api_key", "GroupSecret", "password", "Authorization", "cookie", "privateKey"]) {
      expect(isSecretFieldName(name)).toBe(true);
    }
  });

  it("gives up the tail only when there is enough value to spare it", () => {
    expect(redactSecretValue("abcdefgh")).toBe("***efgh");
    expect(redactSecretValue("abcd")).toBe("***");
    expect(redactSecretValue({ nested: 1 })).toBe("***");
  });
});

describe("configIssues secret redaction", () => {
  let home = "";

  async function loadWithConfigFile(content: string): Promise<typeof import("../src/config.js")> {
    home = join(tmpdir(), `tomo-redact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(join(home, ".tomo"), { recursive: true });
    writeFileSync(join(home, ".tomo", "config.json"), content);
    vi.resetModules();
    vi.stubEnv("HOME", home);
    return import("../src/config.js");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
  });

  // `parseChannels` validates a channel entry as one object, so a single
  // mistyped field used to stringify its siblings with it — and configIssues
  // is printed by `tomo status`, the `tomo config` banner, and
  // `assertConfigValid()`'s throw (which launchd appends to
  // ~/.tomo/logs/launchd.err.log).
  it("never prints a bot token when a sibling field is invalid", async () => {
    const { configIssues, assertConfigValid } = await loadWithConfigFile(JSON.stringify({
      channels: { telegram: { token: TOKEN, allowlist: "123456789" } },
    }));

    const report = configIssues.join("\n");
    // Still an actionable message: which entry, which field, and enough of the
    // token to tell which one is on disk.
    expect(report).toContain("channels.telegram");
    expect(report).toContain("allowlist");
    expect(report).toContain("***9xQz");
    expect(report).not.toContain(TOKEN);
    expect(report).not.toContain("AAH-not-a-real-bot-token");

    // The same string is what the daemon dies with under launchd.
    expect(() => assertConfigValid()).toThrow(/channels\.telegram/);
    try {
      assertConfigValid();
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }

    const { renderStatusReport } = await import("../src/cli/status.js");
    const rendered = renderStatusReport({
      version: "0.0.0",
      daemon: { pid: null, uptimeMs: null, autostart: false },
      configIssues,
      channels: [],
      sessions: [],
      cron: { total: 0, enabled: 0, failing: 0, upcoming: [] },
    });
    expect(rendered).toContain("daemon will refuse to start");
    expect(rendered).not.toContain(TOKEN);
  });

  it("redacts a value that is itself the secret", async () => {
    const { configIssues } = await loadWithConfigFile(JSON.stringify({
      groupSecret: 42,
      litellm: { baseUrl: "http://localhost:4000", apiKey: { oops: TOKEN } },
    }));

    const report = configIssues.join("\n");
    expect(report).toContain("groupSecret");
    expect(report).not.toContain("42");
    expect(report).not.toContain(TOKEN);
  });
});

describe("logger redaction", () => {
  it("censors secret fields at every depth the daemon logs at", () => {
    const written: string[] = [];
    const log = pino(
      { level: "debug", redact: { paths: LOG_REDACT_PATHS } },
      { write: (chunk: string) => void written.push(chunk) } as unknown as pino.DestinationStream,
    );

    log.info({ token: TOKEN }, "top level");
    log.info({ channel: { name: "telegram", token: TOKEN } }, "nested");
    log.info({ config: { litellm: { apiKey: "sk-secret" } } }, "twice nested");
    log.info({ key: "dm:alice", sessionKey: "dm:alice" }, "identifiers");

    const out = written.join("");
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("sk-secret");
    expect(out.match(/\[Redacted\]/g)).toHaveLength(3);
    // Not everything named "key" is a credential.
    expect(out).toContain('"key":"dm:alice"');
    expect(out).toContain('"sessionKey":"dm:alice"');
  });

  it("wires those paths into the real logger", async () => {
    const dir = join(tmpdir(), `tomo-logger-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const file = join(dir, "tomo.log");
    vi.resetModules();
    vi.stubEnv("TOMO_LOG_FILE", file);
    try {
      const { log } = await import("../src/logger.js");
      log.error({ channel: { name: "telegram", token: TOKEN } }, "redaction probe");

      // pino/file runs in a worker thread, so the write is not synchronous.
      const deadline = Date.now() + 5000;
      let contents = "";
      while (Date.now() < deadline) {
        try {
          contents = readFileSync(file, "utf-8");
        } catch { /* not created yet */ }
        if (contents.includes("redaction probe")) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(contents).toContain("redaction probe");
      expect(contents).toContain("[Redacted]");
      expect(contents).not.toContain(TOKEN);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
