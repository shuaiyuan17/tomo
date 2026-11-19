import { log } from "../logger.js";
import type { McpConnection, McpConnectionState } from "../mcp/live-status.js";
import { shortErrorMessage } from "../error-text.js";

/** Automatic reconnects of one server in one session, per rolling hour. */
export const MCP_AUTO_RECONNECT_MAX_PER_HOUR = 3;
/** Wait after the first automatic attempt; doubles with each further one. */
export const MCP_AUTO_RECONNECT_BASE_BACKOFF_MS = 30_000;
/** At most one "still failing" owner notice per server in this window. */
export const MCP_GIVE_UP_NOTICE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Where a status snapshot came from (logged with each attempt). */
export type McpStatusTrigger = "init" | "status-read" | "pre-turn";

export interface McpHealthMonitorDeps {
  /** Ask the key's live session to reconnect one server; rejects on failure. */
  reconnect(key: string, server: string): Promise<void>;
  /** The existing owner-notice path (Agent.notifyOwner). Must not be called often: see the cooldown. */
  notifyOwner(text: string): Promise<unknown> | unknown;
  now?: () => number;
  maxAttemptsPerHour?: number;
  baseBackoffMs?: number;
  noticeCooldownMs?: number;
}

export type McpReconnectOutcome = "reconnected" | "failed" | "backoff" | "capped";

/**
 * Watches the SDK-reported MCP connection state of live sessions:
 *
 * - logs the lifecycle — what a session started with, each connect /
 *   disconnect transition, each reconnect attempt and its outcome, and the
 *   connections going away with the session;
 * - recovers a server the SDK reports `failed` by calling the session's
 *   `reconnectMcpServer` for it, with exponential backoff and a hard cap per
 *   rolling hour (never a loop: an attempt only happens when a status
 *   snapshot arrives, and the cap holds whatever arrives);
 * - when the cap is spent and the server is still failing, tells the owner
 *   once per server per cooldown through the owner-notice path.
 *
 * `needs-auth` is left to the OAuth flow (a reconnect cannot sign in), and
 * `pending` / `disabled` are not failures.
 */
export class McpHealthMonitor {
  private readonly states = new Map<string, Map<string, McpConnectionState>>();
  private readonly attempts = new Map<string, number[]>();
  private readonly inFlight = new Map<string, Promise<McpReconnectOutcome>>();
  private readonly noticeAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly noticeCooldownMs: number;

  constructor(private readonly deps: McpHealthMonitorDeps) {
    this.now = deps.now ?? Date.now;
    this.maxAttempts = deps.maxAttemptsPerHour ?? MCP_AUTO_RECONNECT_MAX_PER_HOUR;
    this.baseBackoffMs = deps.baseBackoffMs ?? MCP_AUTO_RECONNECT_BASE_BACKOFF_MS;
    this.noticeCooldownMs = deps.noticeCooldownMs ?? MCP_GIVE_UP_NOTICE_COOLDOWN_MS;
  }

  /** Last state seen for `server` on `key` (tests and /mcp). */
  stateOf(key: string, server: string): McpConnectionState | undefined {
    return this.states.get(key)?.get(server);
  }

  /**
   * One status snapshot from `key`'s live session. Logs what changed since
   * the last one and starts an automatic reconnect for each failed server
   * the budget allows. Resolves once those attempts settle; never rejects.
   */
  async observe(key: string, connections: McpConnection[] | null, trigger: McpStatusTrigger): Promise<void> {
    if (!connections) return;
    const previous = this.states.get(key);
    const next = new Map(connections.map((connection) => [connection.name, connection.status]));
    if (!previous) {
      const byState: Partial<Record<McpConnectionState, string[]>> = {};
      for (const [name, status] of next) (byState[status] ??= []).push(name);
      log.info({ key, trigger, ...byState }, "MCP servers reported by live session");
    } else {
      for (const [name, status] of next) {
        const before = previous.get(name);
        if (before === status) continue;
        if (status === "connected") log.info({ key, server: name, from: before ?? null, trigger }, "MCP server connected");
        else if (before === "connected") log.warn({ key, server: name, to: status, trigger }, "MCP server disconnected");
        else log.info({ key, server: name, from: before ?? null, to: status, trigger }, "MCP server state changed");
      }
      for (const name of previous.keys()) {
        if (!next.has(name)) log.info({ key, server: name, trigger }, "MCP server no longer reported by live session");
      }
    }
    this.states.set(key, next);
    const failed = [...next].filter(([, status]) => status === "failed").map(([name]) => name);
    if (!previous) for (const name of failed) log.warn({ key, server: name, trigger }, "MCP server failed to connect");
    await Promise.all(failed.map((name) => this.autoReconnect(key, name, trigger)));
  }

  /**
   * One automatic reconnect of a failed server, if the budget allows it:
   * at most `maxAttempts` per rolling hour, each later one at least
   * `baseBackoffMs * 2^(n-1)` after the n-th. One attempt per server and
   * session at a time.
   */
  autoReconnect(key: string, server: string, trigger: McpStatusTrigger): Promise<McpReconnectOutcome> {
    const id = `${key}\0${server}`;
    const running = this.inFlight.get(id);
    if (running) return running;
    const now = this.now();
    const recent = (this.attempts.get(id) ?? []).filter((at) => now - at < HOUR_MS);
    this.attempts.set(id, recent);
    if (recent.length >= this.maxAttempts) {
      this.giveUp(key, server, recent.length);
      return Promise.resolve("capped");
    }
    const last = recent.at(-1);
    if (last !== undefined && now < last + this.baseBackoffMs * 2 ** (recent.length - 1)) {
      log.debug({ key, server, attempts: recent.length }, "MCP auto-reconnect waiting out its backoff");
      return Promise.resolve("backoff");
    }
    recent.push(now);
    const attempt = recent.length;
    log.info({ key, server, attempt, max: this.maxAttempts, trigger }, "MCP auto-reconnect attempt");
    const result = this.run(key, server, { attempt, trigger }).then((ok): McpReconnectOutcome => {
      if (ok) return "reconnected";
      if (attempt >= this.maxAttempts) this.giveUp(key, server, attempt);
      return "failed";
    }).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, result);
    return result;
  }

  /** An explicit reconnect (the web Study's button, `/mcp reconnect`). Outside the automatic budget. */
  async reconnectNow(key: string, server: string): Promise<boolean> {
    const id = `${key}\0${server}`;
    const running = this.inFlight.get(id);
    if (running) return (await running) === "reconnected";
    log.info({ key, server }, "MCP reconnect requested by owner");
    const result = this.run(key, server, { manual: true });
    this.inFlight.set(id, result.then((ok) => ok ? "reconnected" : "failed"));
    try { return await result; } finally { this.inFlight.delete(id); }
  }

  /** The session is gone: its connections closed with it. */
  sessionClosed(key: string): void {
    const states = this.states.get(key);
    if (states?.size) log.info({ key, servers: [...states.keys()] }, "MCP connections closed with live session");
    this.states.delete(key);
    for (const id of [...this.attempts.keys()]) if (id.startsWith(`${key}\0`)) this.attempts.delete(id);
  }

  private async run(key: string, server: string, context: Record<string, unknown>): Promise<boolean> {
    const started = this.now();
    try {
      await this.deps.reconnect(key, server);
      const before = this.states.get(key)?.get(server) ?? null;
      this.states.get(key)?.set(server, "connected");
      log.info({ key, server, from: before, ms: this.now() - started, ...context }, "MCP reconnect succeeded");
      return true;
    } catch (err) {
      log.warn({ key, server, error: shortErrorMessage(err), ms: this.now() - started, ...context }, "MCP reconnect failed");
      return false;
    }
  }

  /** Budget spent and still failing: tell the owner, once per server per cooldown. */
  private giveUp(key: string, server: string, attempts: number): void {
    const now = this.now();
    const last = this.noticeAt.get(server);
    if (last !== undefined && now - last < this.noticeCooldownMs) return;
    this.noticeAt.set(server, now);
    log.error({ key, server, attempts }, "MCP server still failing after automatic reconnects; notifying owner");
    const text = `⚠️ MCP server "${server}" is down, and ${attempts} automatic reconnect${attempts === 1 ? "" : "s"} in the last hour did not bring it back. `
      + `Its tools fail until it reconnects. Try /mcp reconnect ${server} (or Reconnect on the web MCP page), or /new for a fresh session.`;
    void Promise.resolve().then(() => this.deps.notifyOwner(text)).catch((err: unknown) => {
      log.warn({ server, error: shortErrorMessage(err) }, "Could not send the MCP failure notice");
    });
  }
}
