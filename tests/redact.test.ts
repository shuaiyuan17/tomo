import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import {
  LOG_REDACT_PATHS,
  isSecretFieldName,
  redactLogRecord,
  redactSecretValue,
  redactSerializedError,
  redactSecrets,
  scrubSecretValues,
} from "../src/redact.js";

// A token shaped like a real Telegram one. Long enough that `***` + last four
// is meaningfully different from the whole thing.
const TOKEN = "8123456:AAH-not-a-real-bot-token-abcdef9xQz";

describe("redactSecrets", () => {
  it("redacts credential-shaped field names and leaves the rest verbatim", () => {
    expect(redactSecrets({ token: TOKEN, allowlist: "123456789" })).toEqual({
      token: "***9xQz",
      allowlist: "123456789",
    });
    expect(redactSecrets({ litellm: { baseUrl: "http://x", apiKey: "sk-abcdef" } })).toEqual({
      // Too short to keep a tail: four of nine characters is not a fingerprint.
      litellm: { baseUrl: "http://x", apiKey: "***" },
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
    // A real credential is long, and its last four characters identify which
    // one it is. A short value's last four are a substantial share of it.
    expect(redactSecretValue("abcdefghijkl")).toBe("***ijkl");
    expect(redactSecretValue(TOKEN)).toBe("***9xQz");
    expect(redactSecretValue("abcdefghijk")).toBe("***");
    expect(redactSecretValue("abcde")).toBe("***");
    expect(redactSecretValue("abcd")).toBe("***");
    expect(redactSecretValue({ nested: 1 })).toBe("***");
  });

  it("matches secret names whatever the casing or separator", () => {
    for (const name of ["Token", "TOKEN", "API_KEY", "X-Api-Key", "apiKey", "Client_Secret"]) {
      expect(isSecretFieldName(name)).toBe(true);
    }
  });

  // A `seen` set that is never unwound reports the second sighting of a
  // shared-but-acyclic node as a cycle. Config and log objects are full of
  // shared references, so this turned real values into "[Circular]".
  it("distinguishes a shared reference from a cycle", () => {
    const shared = { name: "alice" };
    expect(redactSecrets({ a: shared, b: shared })).toEqual({
      a: { name: "alice" },
      b: { name: "alice" },
    });

    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(redactSecrets(cyclic)).toEqual({ name: "loop", self: "[Circular]" });
  });

  it("passes structured non-plain values through instead of flattening them", () => {
    const when = new Date("2020-01-01T00:00:00.000Z");
    const out = redactSecrets({ when, tags: new Set(["a"]), re: /x/ }) as Record<string, unknown>;
    // Rebuilding these from Object.entries would leave {} and destroy the
    // value they were logged for.
    expect(out.when).toBe(when);
    expect(out.tags).toBeInstanceOf(Set);
    expect(out.re).toBeInstanceOf(RegExp);
  });
});

// The field-name rule protects structured data. It cannot reach the pino
// MESSAGE, and that is where the daemon's largest exposure is:
// `summarizeToolResult` puts the first 500 characters of every tool result
// into the message at info, so `Read ~/.tomo/config.json` wrote live
// credentials into ~/.tomo/logs/tomo.log.
describe("redactLogRecord", () => {
  it("censors secret-named fields at any depth and returns the record when there is nothing to censor", () => {
    const clean = { sessionKey: "dm:alice", nested: { count: 2 } };
    // Untouched AND not cloned: this runs on every log line at debug level.
    expect(redactLogRecord(clean)).toBe(clean);

    expect(redactLogRecord({ config: { channels: { telegram: { token: TOKEN } } } }))
      .toEqual({ config: { channels: { telegram: { token: "[Redacted]" } } } });
    expect(redactLogRecord({ list: [{ apiKey: "sk-live-abcdefghijkl" }] }))
      .toEqual({ list: [{ apiKey: "[Redacted]" }] });
  });
});

describe("redactSerializedError", () => {
  it("reaches into a serialized error tree that a plain-object walker rejects", () => {
    // pino.stdSerializers.err output has a non-Object prototype, and
    // formatters.log runs before serializers, so this is the only pass that
    // can see inside an error.
    const serialized = Object.create({ notOwn: 1 });
    Object.assign(serialized, {
      type: "Error",
      message: `failed for ${TOKEN}`,
      stack: "Error: failed\n    at x",
      response: { data: { config: { headers: { Authorization: `Bearer ${TOKEN}` } } } },
    });

    const out = redactSerializedError(serialized) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain(TOKEN);
    // Depth 6, past any practical path ladder.
    expect((out.response as Record<string, Record<string, Record<string, Record<string, string>>>>)
      .data.config.headers.Authorization).toBe("[Redacted]");
    // The stack survives — the serializer is wrapped, not replaced.
    expect(out.stack).toBe("Error: failed\n    at x");
    expect(out.type).toBe("Error");
  });

  it("recurses into AggregateError sub-errors", () => {
    const serialized = {
      type: "AggregateError",
      message: "all failed",
      aggregateErrors: [
        { type: "Error", message: `sub failed with ${TOKEN}`, stack: `at f ${TOKEN}` },
      ],
    };
    const text = JSON.stringify(redactSerializedError(serialized));
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("sub failed with ***");
  });
});

describe("scrubSecretValues", () => {
  it("redacts issuer-shaped credentials out of free text", () => {
    const cases: Array<[string, string]> = [
      ["8123456:AAH-not-a-real-bot-token-9xQzAbCdEf", "telegram bot token"],
      ["sk-ant-api03-abcdefghijklmnopqrstuv", "anthropic key"],
      ["sk-abcdefghijklmnopqrstuv", "openai key"],
      ["ghp_abcdefghijklmnopqrstuvwxyz0123", "github token"],
      ["github_pat_11ABCDEFG0abcdefghijklmno", "github fine-grained pat"],
      ["xoxb-123456789012-abcdefghijkl", "slack token"],
      ["AKIAIOSFODNN7EXAMPLE", "aws access key id"],
    ];
    for (const [secret, label] of cases) {
      const scrubbed = scrubSecretValues(`tool output containing ${secret} here`);
      expect(scrubbed, label).not.toContain(secret);
      expect(scrubbed, label).toContain("***");
    }
  });

  it("keeps the key and drops the value for key/value and header forms", () => {
    expect(scrubSecretValues('{"access_token":"abcdef123456","user":"alice"}'))
      .toBe('{"access_token":"***","user":"alice"}');
    expect(scrubSecretValues("Authorization: Bearer abcdef123456"))
      .toContain("Authorization");
    expect(scrubSecretValues("Authorization: Bearer abcdef123456"))
      .not.toContain("abcdef123456");
    expect(scrubSecretValues("client_secret=hunter2hunter2")).toBe("client_secret=***");
    // Non-secrets are left alone; the line still has to read.
    expect(scrubSecretValues("Read /Users/x/notes.md (240 lines)"))
      .toBe("Read /Users/x/notes.md (240 lines)");
  });

  // Verified against real lines in tomo.log that an earlier, looser version of
  // the Bearer/Basic/Token rule destroyed. A log scrubber that mangles prose
  // gets turned off, so these matter as much as the leaks.
  it("leaves ordinary prose alone", () => {
    const untouched = [
      "assuming basic features are supported",
      "Missing token endpoint or client id",
      "OAuth token response did not include access_token",
      "access token expired.",
      "Bearer token refresh failed",
      "Read /Users/x/notes.md (240 lines)",
      "Basic auth is not configured",
      "token: null",
    ];
    for (const line of untouched) {
      expect(scrubSecretValues(line), line).toBe(line);
    }
  });

  it("still catches a real Bearer credential", () => {
    // The whole header value goes, scheme included — redacting only the
    // credential and keeping "Bearer" would be splitting the rule that has to
    // stay atomic.
    expect(scrubSecretValues("Authorization: Bearer abc123def456ghi789jkl"))
      .toBe("Authorization: ***");
    // ...and does not eat the sentence's full stop.
    expect(scrubSecretValues("sent Bearer abc123def456ghi789jkl."))
      .toBe("sent Bearer ***.");
  });

  // grammY reports failures by echoing the request URL, where the token is
  // glued to `bot` with no word boundary in front of the digits.
  it("catches a bot token embedded in an API URL", () => {
    const scrubbed = scrubSecretValues(
      `Call to 'getUpdates' failed: https://api.telegram.org/bot${TOKEN}/getUpdates`,
    );
    expect(scrubbed).not.toContain(TOKEN);
    expect(scrubbed).toContain("api.telegram.org/bot***/getUpdates");
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

/** pino/file runs in a worker thread, so the write is not synchronous. */
async function readWhenReady(file: string, marker: string): Promise<string> {
  const deadline = Date.now() + 5000;
  let contents = "";
  while (Date.now() < deadline) {
    try {
      contents = readFileSync(file, "utf-8");
    } catch { /* not created yet */ }
    if (contents.includes(marker)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return contents;
}

describe("logger redaction", () => {
  it("censors secret fields at every depth the daemon logs at", () => {
    const written: string[] = [];
    // Same three layers logger.ts wires up: the short paths ladder, the deep
    // pass, and the error serializer.
    const log = pino(
      {
        level: "debug",
        redact: { paths: LOG_REDACT_PATHS },
        formatters: { log: (record) => redactLogRecord(record) },
      },
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

  // A ladder of literal redact.paths can always be out-nested. These are the
  // shapes that actually occur and that the ladder alone did not reach.
  it("censors credentials deeper than the path ladder, including inside errors", async () => {
    const dir = join(tmpdir(), `tomo-logger-deep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const file = join(dir, "tomo.log");
    vi.resetModules();
    vi.stubEnv("TOMO_LOG_FILE", file);
    try {
      const { log } = await import("../src/logger.js");

      // 1. Four levels deep — past `*.*.field`.
      log.error({ config: { channels: { telegram: { token: TOKEN } } } }, "deep config");
      // 2. An MCP server entry's Authorization header.
      log.error({ mcpServers: { acme: { headers: { Authorization: `Bearer ${TOKEN}` } } } }, "deep headers");
      // 3. An axios-shaped error carrying the header on the error object.
      const axiosErr = Object.assign(new Error("Request failed"), {
        config: { headers: { Authorization: `Bearer ${TOKEN}` } },
      });
      log.error({ err: axiosErr }, "axios shaped");
      // 4. grammY reports a failure by echoing the request URL.
      log.error(
        { err: new Error(`Call to 'getUpdates' failed: https://api.telegram.org/bot${TOKEN}/getUpdates`) },
        "grammy shaped",
      );
      // 5. The message itself — a tool result summary, which no object-level
      //    redaction can reach.
      log.info({ tool: "Read" }, `{"token":"${TOKEN}","allowlist":["123"]}`);

      const contents = await readWhenReady(file, "grammy shaped");
      expect(contents).toContain("deep config");
      expect(contents).toContain("axios shaped");
      expect(contents).toContain("grammy shaped");
      expect(contents).not.toContain(TOKEN);
      // The stack still survives redaction — the err serializer is wrapped,
      // not replaced.
      expect(contents).toContain("\"stack\"");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wires those paths into the real logger", async () => {
    const dir = join(tmpdir(), `tomo-logger-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const file = join(dir, "tomo.log");
    vi.resetModules();
    vi.stubEnv("TOMO_LOG_FILE", file);
    try {
      const { log } = await import("../src/logger.js");
      log.error({ channel: { name: "telegram", token: TOKEN } }, "redaction probe");

      const contents = await readWhenReady(file, "redaction probe");

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
