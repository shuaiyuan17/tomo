import { createConnection, type Socket } from "node:net";
import type { ClientFrame, ServerFrame } from "./protocol.js";
import type { CompactReservation } from "../lcm/background-gate.js";

/**
 * The daemon's answer to `tomo lcm` asking to rewrite a session:
 * - `approved`: the compact is marked pending on the session; call `finish()`
 *   once the rewrite is over (closing the process does the same).
 * - `refused`: the session has background work (see the reservation).
 * - `no-daemon`: nothing is listening and no daemon process is alive, so
 *   there is no live session to reload.
 * - `unconfirmed`: a daemon may be running but did not give an answer
 *   (timeout, an older daemon, a connection error). Callers fail closed.
 */
export type CompactReserveResult =
  | { status: "approved"; finish(): Promise<void> }
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
 * always opens with a snapshot frame, which this client ignores. On approval
 * the connection stays open: the daemon finishes the reservation when it is
 * told to, or when the connection drops.
 */
export function reserveCompact(socketPath: string, sdkSessionId: string, opts: ReserveOptions): Promise<CompactReserveResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    const socket: Socket = createConnection(socketPath);
    const settle = (result: CompactReserveResult, keepOpen = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!keepOpen) socket.destroy();
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
          // Stop buffering snapshot/event frames we no longer read.
          socket.removeAllListeners("data");
          socket.resume();
          settle({
            status: "approved",
            finish: () => new Promise<void>((done) => {
              if (socket.destroyed) return done();
              const fin: ClientFrame = { kind: "compact-finish", sdkSessionId };
              socket.end(JSON.stringify(fin) + "\n", () => done());
              socket.once("close", () => done());
            }),
          }, true);
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
