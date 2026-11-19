import { createConnection } from "node:net";
import type { ClientFrame, ServerFrame } from "./protocol.js";

/**
 * What the daemon said about a session's background tasks:
 * - `ok`: the live count (0 when the session has no live SDK session).
 * - `unreachable`: no daemon on the socket. With no daemon there is no live
 *   session to reload, so nothing can be killed.
 * - `unsupported`: a daemon too old to answer the query.
 * - `timeout`: the daemon accepted the connection but did not answer.
 */
export type BackgroundTaskQueryResult =
  | { status: "ok"; count: number }
  | { status: "unreachable" | "unsupported" | "timeout" };

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Ask the daemon, over the watch socket, how many background tasks the live
 * session behind `sdkSessionId` is running. The socket is the existing
 * CLI ↔ daemon channel (`tomo watch` uses it); the server always opens with a
 * snapshot frame, which this one-shot client ignores.
 */
export function queryBackgroundTasks(
  socketPath: string,
  sdkSessionId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BackgroundTaskQueryResult> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection(socketPath);
    const finish = (result: BackgroundTaskQueryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);
    socket.setEncoding("utf-8");
    socket.on("connect", () => {
      const frame: ClientFrame = { kind: "background-tasks", sdkSessionId };
      socket.write(JSON.stringify(frame) + "\n");
    });
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        let frame: ServerFrame;
        try {
          frame = JSON.parse(line) as ServerFrame;
        } catch {
          continue;
        }
        if (frame.kind === "background-tasks" && frame.sdkSessionId === sdkSessionId) {
          finish({ status: "ok", count: frame.count });
          return;
        }
        // A daemon that predates the query answers it with a generic refusal.
        if (frame.kind === "send-result" && !frame.ok) {
          finish({ status: "unsupported" });
          return;
        }
      }
    });
    socket.on("error", () => finish({ status: "unreachable" }));
    socket.on("close", () => finish({ status: "unreachable" }));
  });
}
