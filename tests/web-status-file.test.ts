import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWebStatus, WEB_STATUS_FILE } from "../src/web/status-file.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "tomo-web-status-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const good = { state: "backoff", port: null, targetPort: 9465, pid: null, restarts: 3, nextRetryAt: 1, lastError: "x", daemonPid: 10, updatedAt: 2 };
const write = (value: unknown) => writeFileSync(join(home, WEB_STATUS_FILE), JSON.stringify(value));

describe("readWebStatus", () => {
  it("reads a well-formed record", () => {
    write(good);
    expect(readWebStatus(home)).toEqual(good);
  });

  it("rejects records a damaged file could turn into a crashing probe", () => {
    write({ ...good, targetPort: 70_000 });
    expect(readWebStatus(home)).toBeNull();
    write({ ...good, port: 1.5 });
    expect(readWebStatus(home)?.port).toBeNull();
    write({ ...good, state: "weird" });
    expect(readWebStatus(home)).toBeNull();
  });

  it("returns null for a missing or unparseable file", () => {
    expect(readWebStatus(home)).toBeNull();
    writeFileSync(join(home, WEB_STATUS_FILE), "{");
    expect(readWebStatus(home)).toBeNull();
  });
});
