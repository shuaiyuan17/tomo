import { afterEach, describe, expect, it, vi } from "vitest";
import { watchBus } from "../src/watch/bus.js";

// src/logger.ts: the issue tap that turns warn/error lines into `tomo watch`
// issue events, and the module-level hygiene that keeps `npm test` quiet.
// These lived in watch-bus.test.ts, but the unit under test is the logger.

afterEach(() => {
  watchBus.reset();
  vi.restoreAllMocks();
});

describe("logger issue tap", () => {
  it("publishes warn/error log calls as issue events", async () => {
    const { log } = await import("../src/logger.js");
    watchBus.reset();

    log.warn({ err: new Error("disk full") }, "Could not save");
    log.error("outright failure");
    log.info("routine line");

    const issues = watchBus.recent().filter((e) => e.type === "issue");
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ level: "warn" });
    expect((issues[0] as { msg: string }).msg).toContain("Could not save");
    expect((issues[0] as { msg: string }).msg).toContain("disk full");
    expect(issues[1]).toMatchObject({ level: "error", msg: "outright failure" });
  });

  it("scrubs credentials out of the error message it publishes", async () => {
    // grammY echoes the request URL in its error text, and the URL carries
    // the bot token. `err.message` is read straight off the Error here — the
    // pino `err` serializer never sees this value — so the token went out to
    // every `tomo watch` client and into logs/activity.ndjson, a file on disk
    // that ends up attached to bug reports.
    const { log } = await import("../src/logger.js");
    watchBus.reset();
    const token = "8123456789:AAHfake-Token-Value_for-tests-01234567";

    log.warn(
      { err: new Error(`Call to 'sendMessage' failed! (https://api.telegram.org/bot${token}/sendMessage)`) },
      "Telegram send failed",
    );
    // The same value arriving as a plain string arg, and as a bare Error.
    log.error(new Error(`bot_token=${token} rejected`));

    const issues = watchBus.recent().filter((e) => e.type === "issue") as Array<{ msg: string }>;
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.msg).join("\n")).not.toContain(token);
    expect(issues[0].msg).toContain("Telegram send failed");
    expect(issues[0].msg).toContain("***");
  });
});

describe("logger module hygiene", () => {
  it("does not add a process 'exit' listener per evaluation", async () => {
    // Each pino TRANSPORT is a worker thread, and pino registers a
    // `process.on("exit")` teardown hook for it. Vitest gives every test file
    // a fresh module registry inside one worker process, so logger.ts is
    // evaluated once per file: the eleventh evaluation printed
    // `MaxListenersExceededWarning: 11 exit listeners added to [process]`
    // into the middle of `npm test`, with a hundred-odd worker threads behind
    // it. Under test the logger writes through a direct destination instead.
    const before = process.listenerCount("exit");

    for (let i = 0; i < 12; i++) {
      vi.resetModules();
      await import("../src/logger.js");
    }

    expect(process.listenerCount("exit")).toBe(before);
    vi.resetModules();
  });
});
