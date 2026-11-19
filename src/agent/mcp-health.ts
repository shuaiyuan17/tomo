import { log } from "../logger.js";
import type { McpConnection, McpConnectionState } from "../mcp/live-status.js";
import { shortErrorMessage } from "../error-text.js";

/** Automatic reconnect rounds per server, across every session, per rolling hour. */
export const MCP_AUTO_RECONNECT_MAX_PER_HOUR = 3;
/** Wait after the first automatic round; doubles with each further one. */
export const MCP_AUTO_RECONNECT_BASE_BACKOFF_MS = 30_000;
/** How soon a round deferred because every failing session was busy looks again. */
export const MCP_DEFERRED_RECHECK_MS = 5_000;
/** At most one delivered "still failing" owner notice per server in this window. */
export const MCP_GIVE_UP_NOTICE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Where a status snapshot or a round came from (logged). */
export type McpStatusTrigger = "init" | "status-read" | "pre-turn" | "timer" | "idle";

export interface McpHealthMonitorDeps {
  /**
   * Reconnect one server on the key's CURRENT live session; rejects on
   * failure. The monitor only asks while `isIdle(key)` holds.
   */
  reconnect(key: string, server: string): Promise<void>;
  /** The key has a live session with no turn running (a reconnect would not cut a tool call). */
  isIdle(key: string): boolean;
  /** The existing owner-notice path (Agent.notifyOwner): true once delivered. */
  notifyOwner(text: string): Promise<boolean>;
  now?: () => number;
  maxAttemptsPerHour?: number;
  baseBackoffMs?: number;
  noticeCooldownMs?: number;
}

export type McpRoundOutcome = "reconnected" | "failed" | "backoff" | "capped" | "deferred" | "nothing";

interface ServerHealth {
  /** Start times of automatic rounds in the last hour. Server-wide; a closing session never clears it. */
  attempts: number[];
  inFlight?: Promise<McpRoundOutcome>;
  timer?: ReturnType<typeof setTimeout>;
  noticeAt?: number;
  noticeSending?: boolean;
}

/**
 * Health of MCP servers across every live session, PER SERVER: sessions only
 * report what the SDK says (`observe`); this decides when to reconnect.
 *
 * - Lifecycle logs: what a session started with, each connect / disconnect
 *   transition, each round and reconnect with its outcome, and the
 *   connections closing with the session.
 * - A server some session reports `failed` gets automatic reconnect ROUNDS:
 *   one at a time per server, each reconnecting it in every failing session
 *   that is idle, with exponential backoff and at most `maxAttempts` rounds
 *   per rolling hour across all sessions — a shared server going down cannot
 *   set off one storm per session. A busy session is never reconnected under
 *   its turn: it stays pending until it is idle (`sessionIdle`, or a short
 *   recheck timer). Retries are timer-driven, so an idle conversation still
 *   recovers — and the owner still hears when it does not.
 * - Budget spent and still failing: one owner notice per server per
 *   cooldown, counted only once delivered. The cooldown is in memory, so a
 *   restart can repeat a notice.
 *
 * `needs-auth` is left to the OAuth flow; `pending` / `disabled` are not failures.
 */
export class McpHealthMonitor {
  private readonly states = new Map<string, Map<string, McpConnectionState>>();
  /** Bumped by sessionClosed: a reconnect result for an older session of the key is not applied. */
  private readonly epochs = new Map<string, number>();
  private readonly servers = new Map<string, ServerHealth>();
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly noticeCooldownMs: number;
  private stopped = false;

  constructor(private readonly deps: McpHealthMonitorDeps) {
    this.now = deps.now ?? Date.now;
    this.maxAttempts = deps.maxAttemptsPerHour ?? MCP_AUTO_RECONNECT_MAX_PER_HOUR;
    this.baseBackoffMs = deps.baseBackoffMs ?? MCP_AUTO_RECONNECT_BASE_BACKOFF_MS;
    this.noticeCooldownMs = deps.noticeCooldownMs ?? MCP_GIVE_UP_NOTICE_COOLDOWN_MS;
  }

  /** Last state seen for `server` on `key`. */
  stateOf(key: string, server: string): McpConnectionState | undefined {
    return this.states.get(key)?.get(server);
  }

  /**
   * One status snapshot from `key`'s CURRENT live session (the caller checks
   * that). Logs what changed and starts a round for each failed server.
   * Resolves once those rounds settle; never rejects.
   */
  async observe(key: string, connections: McpConnection[] | null, trigger: McpStatusTrigger): Promise<void> {
    if (!connections || this.stopped) return;
    const previous = this.states.get(key);
    const next = new Map(connections.map((connection) => [connection.name, connection.status]));
    if (!previous) {
      const byState: Partial<Record<McpConnectionState, string[]>> = {};
      for (const [name, status] of next) (byState[status] ??= []).push(name);
      log.info({ key, trigger, ...byState }, "MCP servers reported by live session");
      for (const name of byState.failed ?? []) log.warn({ key, server: name, trigger }, "MCP server failed to connect");
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
    await Promise.all(failed.map((name) => this.round(name, trigger)));
  }

  /** The key's turn ended: run any reconnect held back while it was busy. */
  sessionIdle(key: string): void {
    for (const [server, status] of this.states.get(key) ?? []) {
      if (status === "failed") void this.round(server, "idle");
    }
  }

  /** The session is gone: its connections closed with it. The server budget stays. */
  sessionClosed(key: string): void {
    const states = this.states.get(key);
    if (states?.size) log.info({ key, servers: [...states.keys()] }, "MCP connections closed with live session");
    this.states.delete(key);
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
    for (const server of states?.keys() ?? []) if (!this.failingKeys(server).length) this.clearTimer(server);
  }

  /** Shutdown: no more rounds, no timers. */
  stop(): void {
    this.stopped = true;
    for (const server of this.servers.keys()) this.clearTimer(server);
  }

  /** An explicit reconnect (the web Study's button, `/mcp reconnect`): outside the automatic budget. */
  async reconnectNow(key: string, server: string): Promise<boolean> {
    const health = this.health(server);
    if (health.inFlight) await health.inFlight;
    log.info({ key, server }, "MCP reconnect requested by owner");
    return this.reconnectOne(key, server, { manual: true });
  }

  /**
   * One automatic round for `server`, if the budget allows and some failing
   * session is idle; otherwise a timer for when it could run.
   */
  round(server: string, trigger: McpStatusTrigger): Promise<McpRoundOutcome> {
    const health = this.health(server);
    if (health.inFlight) return health.inFlight;
    if (this.stopped) return Promise.resolve("nothing");
    const failing = this.failingKeys(server);
    if (!failing.length) { this.clearTimer(server); return Promise.resolve("nothing"); }
    const now = this.now();
    health.attempts = health.attempts.filter((at) => now - at < HOUR_MS);
    if (health.attempts.length >= this.maxAttempts) {
      this.giveUp(server, health.attempts.length);
      // The budget comes back as the oldest round leaves the window.
      this.setTimer(server, health.attempts[0] + HOUR_MS - now);
      return Promise.resolve("capped");
    }
    const last = health.attempts.at(-1);
    const readyAt = last === undefined ? now : last + this.baseBackoffMs * 2 ** (health.attempts.length - 1);
    if (now < readyAt) {
      this.setTimer(server, readyAt - now);
      return Promise.resolve("backoff");
    }
    const idle = failing.filter((key) => this.deps.isIdle(key));
    if (!idle.length) {
      log.info({ server, sessions: failing, trigger }, "MCP reconnect deferred: every failing session is mid-turn");
      this.setTimer(server, MCP_DEFERRED_RECHECK_MS);
      return Promise.resolve("deferred");
    }
    this.clearTimer(server);
    health.attempts.push(now);
    const attempt = health.attempts.length;
    log.info({ server, sessions: idle, attempt, max: this.maxAttempts, trigger }, "MCP auto-reconnect round");
    const run = Promise.all(idle.map((key) => this.reconnectOne(key, server, { attempt, trigger }))).then((results): McpRoundOutcome => {
      if (results.every(Boolean) && !this.failingKeys(server).length) return "reconnected";
      if (attempt >= this.maxAttempts) this.giveUp(server, attempt);
      return "failed";
    }).finally(() => {
      health.inFlight = undefined;
      // Something still failing (here or in a session that was busy): the next round is the timer's.
      if (!this.stopped && this.failingKeys(server).length) void this.round(server, "timer");
    });
    health.inFlight = run;
    return run;
  }

  private async reconnectOne(key: string, server: string, context: Record<string, unknown>): Promise<boolean> {
    const epoch = this.epochs.get(key) ?? 0;
    const started = this.now();
    try {
      await this.deps.reconnect(key, server);
      // Applied only to the session it was asked of.
      if ((this.epochs.get(key) ?? 0) !== epoch) return true;
      const before = this.states.get(key)?.get(server) ?? null;
      this.states.get(key)?.set(server, "connected");
      log.info({ key, server, from: before, ms: this.now() - started, ...context }, "MCP reconnect succeeded");
      return true;
    } catch (err) {
      log.warn({ key, server, error: shortErrorMessage(err), ms: this.now() - started, ...context }, "MCP reconnect failed");
      return false;
    }
  }

  private failingKeys(server: string): string[] {
    return [...this.states].filter(([, states]) => states.get(server) === "failed").map(([key]) => key);
  }

  private health(server: string): ServerHealth {
    let health = this.servers.get(server);
    if (!health) this.servers.set(server, health = { attempts: [] });
    return health;
  }

  private setTimer(server: string, delayMs: number): void {
    const health = this.health(server);
    if (health.timer || this.stopped) return;
    health.timer = setTimeout(() => {
      health.timer = undefined;
      void this.round(server, "timer");
    }, Math.max(0, delayMs));
    health.timer.unref?.();
  }

  private clearTimer(server: string): void {
    const health = this.servers.get(server);
    if (health?.timer) { clearTimeout(health.timer); health.timer = undefined; }
  }

  /** Budget spent and still failing: tell the owner, once per server per cooldown, counted when delivered. */
  private giveUp(server: string, attempts: number): void {
    const health = this.health(server);
    const now = this.now();
    if (health.noticeSending || (health.noticeAt !== undefined && now - health.noticeAt < this.noticeCooldownMs)) return;
    health.noticeSending = true;
    log.error({ server, attempts }, "MCP server still failing after automatic reconnects; notifying owner");
    const text = `⚠️ MCP server "${server}" is down, and ${attempts} automatic reconnect${attempts === 1 ? "" : "s"} in the last hour did not bring it back. `
      + `Its tools fail until it reconnects. Try /mcp reconnect ${server} (or Reconnect on the web MCP page), or /new for a fresh session.`;
    void Promise.resolve().then(() => this.deps.notifyOwner(text)).then((delivered) => {
      if (delivered) health.noticeAt = this.now();
      else log.warn({ server }, "MCP failure notice not delivered; will try again");
    }, (err: unknown) => {
      log.warn({ server, error: shortErrorMessage(err) }, "Could not send the MCP failure notice");
    }).finally(() => { health.noticeSending = false; });
  }
}
