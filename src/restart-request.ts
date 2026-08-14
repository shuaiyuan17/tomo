import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultRuntimePaths } from "./runtime-paths.js";
import { TOMO_SESSION_KEY_ENV } from "./restart-reason.js";

export const RESTART_REQUEST_MARKER = "TOMO_RESTART_REQUEST:";
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_REQUEST_DIR = join(dirname(defaultRuntimePaths.restartReasonFile), "restart-requests");

export interface RestartRequest {
  id: string;
  sessionKey: string;
  reason?: string;
  requestedAt: string;
}

function requestPath(id: string, requestDir: string): string {
  return join(requestDir, `${id}.json`);
}

/** Persist a session-originated restart until its Bash result is observed. */
export function createRestartRequest(
  sessionKey: string,
  reason?: string,
  requestDir: string = DEFAULT_REQUEST_DIR,
): RestartRequest {
  mkdirSync(requestDir, { recursive: true });
  const request: RestartRequest = {
    id: randomUUID(),
    sessionKey,
    ...(reason ? { reason } : {}),
    requestedAt: new Date().toISOString(),
  };
  writeFileSync(requestPath(request.id, requestDir), `${JSON.stringify(request)}\n`, {
    encoding: "utf-8",
    flag: "wx",
    mode: 0o600,
  });
  return request;
}

export function formatRestartRequestResult(request: RestartRequest): string {
  return [
    "Restart scheduled. Tomo will restart after this Bash result is recorded.",
    `${RESTART_REQUEST_MARKER}${request.id}`,
  ].join("\n");
}

export function restartWorkerInvocation(
  request: RestartRequest,
  cliPath: string,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const workerEnv = { ...env };
  delete workerEnv[TOMO_SESSION_KEY_ENV];
  return {
    command: process.execPath,
    args: [
      cliPath,
      "restart",
      ...(request.reason ? ["--reason", request.reason] : []),
      "--session",
      request.sessionKey,
    ],
    env: workerEnv,
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

/**
 * Consume only the request named by an observed Bash result from the same
 * session. Seeing this marker is the acknowledgement boundary: the SDK has
 * emitted the tool-result event, so restarting can no longer replace it with
 * the CLI's misleading interrupted/rejected fallback.
 */
export function consumeRestartRequestFromToolResult(
  content: unknown,
  sessionKey: string,
  requestDir: string = DEFAULT_REQUEST_DIR,
): RestartRequest | null {
  const text = toolResultText(content);
  const markerIndex = text.indexOf(RESTART_REQUEST_MARKER);
  if (markerIndex === -1) return null;
  const id = text
    .slice(markerIndex + RESTART_REQUEST_MARKER.length)
    .split(/\s/, 1)[0];
  if (!REQUEST_ID_RE.test(id)) return null;

  const path = requestPath(id, requestDir);
  let request: RestartRequest;
  try {
    request = JSON.parse(readFileSync(path, "utf-8")) as RestartRequest;
  } catch {
    return null;
  }
  if (request.id !== id || request.sessionKey !== sessionKey) return null;
  try {
    unlinkSync(path);
  } catch {
    return null;
  }
  return request;
}
