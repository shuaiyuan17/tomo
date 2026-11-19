import { createConnection, type Socket } from "node:net";
import type { ClientFrame, ServerFrame } from "./protocol.js";
import type { CompactReservation } from "../lcm/background-gate.js";

/**
 * The daemon's answer to `tomo lcm` asking to rewrite a session:
 * - `approved`: the compact is marked pending on the session; call `finish()`
 *   once the rewrite is over, whatever its outcome. Exiting without it leaves
 *   the session marked until the daemon's safety timeout.
 * - `refused`: the session has background work (see the reservation).
 * - `no-daemon`: nothing is listening and no daemon process is alive, so
 *   there is no live session to reload.
 * - `unconfirmed`: a daemon may be running but did not give an answer
 *   (timeout, an older daemon, a connection error). Callers fail closed.
 */
export type CompactReserveResult =
  | { status: "approved"; finish(): Promise<boolean> }
  | { status: "refused"; reservation: Extract<CompactReservation, { ok: false }> }
  | { status: "no-daemon" }
  | { status: "unconfirmed"; detail: string };

const DEFAULT_TIMEOUT_MS = 5_000;

export interface ReserveOptions {
  timeoutMs?: number;
  /** Is a daemon process alive (pid file)? Consulted only when the socket refuses. */
  daemonAlive: () => boolean;
}

/**
 * Ask the daemon over the watch socket — the existing CLI ↔ daemon channel
 * (`tomo watch` uses it) — to approve a rewrite of `sdkSessionId`. The server
 * always opens with a snapshot frame, which this client ignores.
 */
export function reserveCompact(socketPath: string, sdkSessionId: string, opts: ReserveOptions): Promise<CompactReserveResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    const socket: Socket = createConnection(socketPath);
    const settle = (result: CompactReserveResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => settle({ status: "unconfirmed", detail: `no answer within ${Math.round(timeoutMs / 1000)}s` }),
      timeoutMs,
    );
    socket.setEncoding("utf-8");
    socket.on("connect", () => {
      connected = true;
      const frame: ClientFrame = { kind: "compact-reserve", sdkSessionId };
      socket.write(JSON.stringify(frame) + "\n");
    });
    let buffer = "";
    socket.on("data", (chunk: string) => {
      if (settled) return;
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
        if (frame.kind === "compact-reserve" && frame.sdkSessionId === sdkSessionId) {
          const reservation = frame.reservation;
          if (!reservation.ok) {
            settle({ status: "refused", reservation });
            return;
          }
          settle({
            status: "approved",
            finish: () => sendFinish(socketPath, { kind: "compact-finish", sdkSessionId, reservation }, timeoutMs),
          });
          return;
        }
        // A daemon that predates the gate answers with a generic refusal.
        if (frame.kind === "send-result" && !frame.ok) {
          settle({ status: "unconfirmed", detail: "the daemon does not support the background-task check (older version?)" });
          return;
        }
      }
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      const code = err.code ?? "";
      if (!connected && (code === "ENOENT" || code === "ECONNREFUSED") && !opts.daemonAlive()) {
        settle({ status: "no-daemon" });
      } else {
        settle({ status: "unconfirmed", detail: `watch socket: ${code || err.message}` });
      }
    });
    socket.on("close", () => settle({ status: "unconfirmed", detail: "the daemon closed the connection" }));
  });
}

/**
 * Report the end of an approved rewrite on a fresh connection (the approval is
 * not tied to the one it came on). True once the daemon acknowledged it.
 */
function sendFinish(socketPath: string, frame: ClientFrame, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection(socketPath);
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    socket.setEncoding("utf-8");
    socket.on("connect", () => socket.write(JSON.stringify(frame) + "\n"));
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        try {
          const reply = JSON.parse(line) as ServerFrame;
          if (reply.kind === "send-result") return settle(reply.ok);
        } catch { /* torn frame */ }
      }
    });
    socket.on("error", () => settle(false));
    socket.on("close", () => settle(false));
  });
}
