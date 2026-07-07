import { createConnection, type Socket } from "node:net";
import type { ClientFrame, ServerFrame, WatchEvent, WatchSnapshot } from "./protocol.js";

export type WatchConnectionState = "connecting" | "connected" | "offline";

export interface WatchClientHandlers {
  onSnapshot(snapshot: WatchSnapshot): void;
  onEvent(event: WatchEvent): void;
  onState(state: WatchConnectionState): void;
  onSendResult?(ok: boolean, error?: string): void;
}

const RECONNECT_DELAYS_MS = [1000, 2000, 5000];

/**
 * Client side of the watch socket: connects, parses NDJSON frames, and
 * reconnects forever with backoff — the TUI stays open 24/7 while the daemon
 * may restart underneath it. Each (re)connect yields a fresh snapshot frame.
 */
export class WatchClient {
  private socket: Socket | null = null;
  private closed = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly handlers: WatchClientHandlers,
  ) {}

  start(): void {
    this.connect();
  }

  /** Drop the current connection and reconnect (fresh snapshot). */
  refresh(): void {
    if (this.closed) return;
    this.socket?.destroy();
  }

  send(text: string): boolean {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return false;
    const frame: ClientFrame = { kind: "send", text };
    this.socket.write(JSON.stringify(frame) + "\n");
    return true;
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.destroy();
    this.socket = null;
  }

  private connect(): void {
    if (this.closed) return;
    this.handlers.onState(this.attempts === 0 ? "connecting" : "offline");

    const socket = createConnection(this.socketPath);
    this.socket = socket;
    socket.setEncoding("utf-8");

    let buffer = "";
    socket.on("connect", () => {
      this.attempts = 0;
      this.handlers.onState("connected");
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) this.handleFrame(line);
      }
    });
    const onGone = () => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.scheduleReconnect();
    };
    socket.on("error", () => socket.destroy());
    socket.on("close", onGone);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.handlers.onState("offline");
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempts, RECONNECT_DELAYS_MS.length - 1)];
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleFrame(line: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(line) as ServerFrame;
    } catch {
      return; // Skip torn/corrupt frames rather than dying.
    }
    if (frame.kind === "snapshot") this.handlers.onSnapshot(frame.snapshot);
    else if (frame.kind === "event") this.handlers.onEvent(frame.event);
    else if (frame.kind === "send-result") this.handlers.onSendResult?.(frame.ok, frame.error);
  }
}
