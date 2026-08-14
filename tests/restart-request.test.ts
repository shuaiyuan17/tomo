import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  consumeRestartRequestFromToolResult,
  createRestartRequest,
  formatRestartRequestResult,
  restartWorkerInvocation,
} from "../src/restart-request.js";

let requestDir: string;

beforeEach(() => {
  requestDir = join(tmpdir(), `tomo-restart-request-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(requestDir, { recursive: true });
});

afterEach(() => {
  rmSync(requestDir, { recursive: true, force: true });
});

describe("restart request handshake", () => {
  it("consumes a request only after its marker returns in the same session's tool result", () => {
    const request = createRestartRequest("dm:shuai", "config changed", requestDir);
    const result = formatRestartRequestResult(request);

    expect(consumeRestartRequestFromToolResult(result, "dm:other", requestDir)).toBeNull();
    expect(consumeRestartRequestFromToolResult(result, "dm:shuai", requestDir)).toEqual(request);
    expect(existsSync(join(requestDir, `${request.id}.json`))).toBe(false);
    expect(consumeRestartRequestFromToolResult(result, "dm:shuai", requestDir)).toBeNull();
  });

  it("accepts array-shaped SDK tool-result content", () => {
    const request = createRestartRequest("telegram:123", undefined, requestDir);
    const content = [{ type: "text", text: formatRestartRequestResult(request) }];

    expect(consumeRestartRequestFromToolResult(content, "telegram:123", requestDir)).toEqual(request);
  });

  it("ignores malformed or unrelated output", () => {
    expect(consumeRestartRequestFromToolResult("Restarted", "dm:shuai", requestDir)).toBeNull();
    expect(consumeRestartRequestFromToolResult("TOMO_RESTART_REQUEST:not-an-id", "dm:shuai", requestDir)).toBeNull();
  });

  it("launches the acknowledged worker without the SDK session environment", () => {
    const request = createRestartRequest("dm:shuai", "config changed", requestDir);
    const worker = restartWorkerInvocation(request, "/opt/tomo/dist/cli.js", {
      TOMO_SESSION_KEY: "dm:shuai",
      KEEP_ME: "yes",
    });

    expect(worker.command).toBe(process.execPath);
    expect(worker.args).toEqual([
      "/opt/tomo/dist/cli.js",
      "restart",
      "--reason",
      "config changed",
      "--session",
      "dm:shuai",
    ]);
    expect(worker.env).toEqual({ KEEP_ME: "yes" });
  });
});
