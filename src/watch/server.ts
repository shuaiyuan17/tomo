import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { log } from "../logger.js";
import { watchBus, type WatchBus } from "./bus.js";
import type { ClientFrame, ServerFrame, WatchSnapshot } from "./protocol.js";

export interface WatchServerDeps {
  /** Built fresh per client connect — includes vitals and feed backfill. */
  getSnapshot(): WatchSnapshot | Promise<WatchSnapshot>;
  /** Route a chat message typed in the TUI into the owner's dm session. */
  sendChat(text: string): Promise<void>;
}

/**
 * Unix-domain-socket event server for `tomo watch`. Accepts local clients,
 * sends a snapshot frame on connect, then relays every WatchBus event as an
 * NDJSON `event` frame. The daemon never depends on clients: writes are
 * fire-and-forget, a client that stops reading is disconnected once its
 * write buffer passes MAX_BUFFERED_BYTES, and client errors only close that
 * client's socket.
 */
export class WatchServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly deps: WatchServerDeps,
    private readonly bus: WatchBus = watchBus,
  ) {}

  start(): void {
    // A stale socket file from a crashed daemon blocks listen(); we hold the
    // pid file, so no other daemon can own it — safe to remove.
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch (err) {
      log.warn({ err, socketPath: this.socketPath }, "Could not remove stale watch socket");
    }

    const server = createServer((socket) => this.handleConnection(socket));
    server.on("error", (err) => {
      log.warn({ err, socketPath: this.socketPath }, "Watch server error");
    });
    server.listen(this.socketPath, () => {
      // Owner-only: the socket carries transcripts and accepts chat sends.
      try {
        chmodSync(this.socketPath, 0o600);
      } catch (err) {
        log.warn({ err }, "Could not chmod watch socket");
      }
      log.info({ socketPath: this.socketPath }, "Watch server listening");
    });
    this.server = server;

    this.unsubscribe = this.bus.subscribe((event) => {
      this.broadcast({ kind: "event", event });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    this.server?.close();
    this.server = null;
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch {
      // Best effort; a leftover file is cleaned on next start.
    }
  }

  private handleConnection(socket: Socket): void {
    this.clients.add(socket);
    socket.setEncoding("utf-8");
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.clients.delete(socket));

    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      // Guard against a client streaming garbage without newlines.
      if (buffer.length > 64 * 1024) {
        socket.destroy();
        return;
      }
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) void this.handleClientLine(socket, line);
      }
    });

    void this.sendSnapshot(socket);
  }

  private async sendSnapshot(socket: Socket): Promise<void> {
    try {
      const snapshot = await this.deps.getSnapshot();
      this.write(socket, { kind: "snapshot", snapshot });
    } catch (err) {
      log.warn({ err }, "Watch snapshot failed");
      socket.destroy();
    }
  }

  private async handleClientLine(socket: Socket, line: string): Promise<void> {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(line) as ClientFrame;
    } catch {
      this.write(socket, { kind: "send-result", ok: false, error: "invalid frame" });
      return;
    }

    if (frame.kind === "send" && typeof frame.text === "string" && frame.text.trim()) {
      try {
        await this.deps.sendChat(frame.text);
        this.write(socket, { kind: "send-result", ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err }, "Watch chat send failed");
        this.write(socket, { kind: "send-result", ok: false, error: msg });
      }
      return;
    }

    this.write(socket, { kind: "send-result", ok: false, error: "unsupported frame" });
  }

  private broadcast(frame: ServerFrame): void {
    if (this.clients.size === 0) return;
    const line = JSON.stringify(frame) + "\n";
    for (const socket of this.clients) {
      this.writeLine(socket, line);
    }
  }

  private write(socket: Socket, frame: ServerFrame): void {
    this.writeLine(socket, JSON.stringify(frame) + "\n");
  }

  /**
   * Backpressure guard: a client that stopped reading (suspended terminal,
   * hung SSH) would otherwise make Node buffer frames in daemon memory
   * without bound. Past the cap we destroy the socket — the TUI's reconnect
   * loop brings it back with a fresh snapshot once it's responsive again.
   */
  private static readonly MAX_BUFFERED_BYTES = 1024 * 1024;

  private writeLine(socket: Socket, line: string): void {
    if (!socket.writable) return;
    if (socket.writableLength > WatchServer.MAX_BUFFERED_BYTES) {
      // Destroy BEFORE logging: log.warn feeds a watch-bus issue event back
      // into this server's broadcast, which re-enters writeLine on this very
      // socket — it must already be dead (writable=false) by then or the
      // over-buffer branch recurses until the stack blows.
      const buffered = socket.writableLength;
      this.clients.delete(socket);
      socket.destroy();
      log.warn({ buffered }, "Watch client too slow; disconnected it");
      return;
    }
    socket.write(line);
  }
}
