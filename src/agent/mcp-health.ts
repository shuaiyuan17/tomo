import { ownerT, type OwnerText } from "../i18n/index.js";
import { log } from "../logger.js";
import type { McpConnection, McpConnectionState } from "../mcp/live-status.js";
import { shortErrorMessage } from "../error-text.js";

/** One automatic reconnect of a server, across all sessions, per this window. */
export const MCP_AUTO_RECONNECT_INTERVAL_MS = 10 * 60 * 1000;
/** How long a turn waits for its pre-turn reconnects before it starts anyway. */
export const MCP_PRE_TURN_WAIT_MS = 20_000;
/** Consecutive failed reconnects of a server (any session) before the owner is told. */
export const MCP_FAILURES_BEFORE_NOTICE = 3;

export interface McpHealthMonitorDeps {
  /** The owner-notice path (Agent.notifyOwner): true once delivered. */
  notifyOwner(text: OwnerText): Promise<boolean>;
  now?: () => number;
  intervalMs?: number;
  preTurnWaitMs?: number;
  failuresBeforeNotice?: number;
}

interface ServerHealth {
  lastAutoAt?: number;
  /** The SDK reconnect now running for this server, in whichever session. At most one. */
  inFlight?: Promise<boolean>;
  failures: number;
  noticeDelivered: boolean;
  noticeSending: boolean;
}

/**
 * MCP health across live sessions, per server.
 *
 * Automatic reconnect happens in ONE place: before a turn starts
 * (`beforeTurn`), which the turn awaits — so it never runs under a turn.
 * It acts on the status it has just read, only on `failed` servers (never
 * `needs-auth`: that is the OAuth flow's), at most once per server per
 * interval across all sessions, and never concurrently with another
 * reconnect of the same server. A wait past `preTurnWaitMs` lets the turn
 * start; the reconnect keeps running and counts as in flight, so nothing
 * retries it meanwhile. No timers, no reconnect from a status read.
 *
 * After `failuresBeforeNotice` consecutive failures of a server the owner is
 * told once (marked only when delivered; reset by a success). In memory:
 * a restart can repeat the notice.
 *
 * Logs: connection state changes per session, and each reconnect's outcome.
 */
export class McpHealthMonitor {
  private readonly states = new Map<string, Map<string, McpConnectionState>>();
  private readonly servers = new Map<string, ServerHealth>();
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly preTurnWaitMs: number;
  private readonly failuresBeforeNotice: number;

  constructor(private readonly deps: McpHealthMonitorDeps) {
    this.now = deps.now ?? Date.now;
    this.intervalMs = deps.intervalMs ?? MCP_AUTO_RECONNECT_INTERVAL_MS;
    this.preTurnWaitMs = deps.preTurnWaitMs ?? MCP_PRE_TURN_WAIT_MS;
    this.failuresBeforeNotice = deps.failuresBeforeNotice ?? MCP_FAILURES_BEFORE_NOTICE;
  }

  stateOf(key: string, server: string): McpConnectionState | undefined {
    return this.states.get(key)?.get(server);
  }

  /** A status snapshot from the key's current session: logged on change, nothing else. */
  observe(key: string, connections: McpConnection[] | null, trigger: string): void {
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
  }

  /** The session is gone: its connections closed with it. */
  sessionClosed(key: string): void {
    const states = this.states.get(key);
    if (states?.size) log.info({ key, servers: [...states.keys()] }, "MCP connections closed with live session");
    this.states.delete(key);
  }

  /**
   * Before a turn on `key`: given the status just read, reconnect each failed
   * server the interval allows and no other reconnect is running for. Waits
   * for them up to `preTurnWaitMs`. Never rejects.
   */
  async beforeTurn(key: string, connections: McpConnection[] | null, reconnect: (server: string) => Promise<void>): Promise<void> {
    this.observe(key, connections, "pre-turn");
    const now = this.now();
    const runs: Promise<boolean>[] = [];
    for (const connection of connections ?? []) {
      if (connection.status !== "failed") continue;
      const health = this.health(connection.name);
      if (health.inFlight) continue;
      if (health.lastAutoAt !== undefined && now - health.lastAutoAt < this.intervalMs) continue;
      health.lastAutoAt = now;
      runs.push(this.run(key, connection.name, reconnect, "auto"));
    }
    if (!runs.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([
      Promise.all(runs).then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), this.preTurnWaitMs); }),
    ]).finally(() => clearTimeout(timer));
    if (!done) log.warn({ key, waitedMs: this.preTurnWaitMs }, "MCP reconnect still running; starting the turn anyway");
  }

  /**
   * An explicit reconnect (web button, `/mcp reconnect`): no interval, but
   * still one at a time per server — it waits until no reconnect of the
   * server is running (however many others were waiting too). After the
   * wait `stillAllowed()` must hold (its session still idle and reserved),
   * or it gives up with "busy". The caller reserves the session.
   */
  async reconnectNow(key: string, server: string, reconnect: (server: string) => Promise<void>, stillAllowed: () => boolean = () => true): Promise<"reconnected" | "failed" | "busy"> {
    const health = this.health(server);
    let waited = false;
    while (health.inFlight) { waited = true; await health.inFlight; }
    if (waited && !stillAllowed()) return "busy";
    return await this.run(key, server, reconnect, "manual") ? "reconnected" : "failed";
  }

  private run(key: string, server: string, reconnect: (server: string) => Promise<void>, kind: "auto" | "manual"): Promise<boolean> {
    const health = this.health(server);
    const started = this.now();
    const result = (async () => {
      try {
        await reconnect(server);
        this.states.get(key)?.set(server, "connected");
        log.info({ key, server, kind, ms: this.now() - started }, "MCP reconnect succeeded");
        health.failures = 0;
        health.noticeDelivered = false;
        return true;
      } catch (err) {
        health.failures++;
        log.warn({ key, server, kind, failures: health.failures, error: shortErrorMessage(err), ms: this.now() - started }, "MCP reconnect failed");
        if (health.failures >= this.failuresBeforeNotice) this.notice(server, health);
        return false;
      }
    })().finally(() => { if (health.inFlight === result) health.inFlight = undefined; });
    health.inFlight = result;
    return result;
  }

  private health(server: string): ServerHealth {
    let health = this.servers.get(server);
    if (!health) this.servers.set(server, health = { failures: 0, noticeDelivered: false, noticeSending: false });
    return health;
  }

  /** Once per failure streak, marked only when delivered. */
  private notice(server: string, health: ServerHealth): void {
    if (health.noticeDelivered || health.noticeSending) return;
    health.noticeSending = true;
    const text = ownerT("notices")("mcpDown", { server, failures: health.failures });
    void Promise.resolve().then(() => this.deps.notifyOwner(text)).then((delivered) => {
      if (delivered) { health.noticeDelivered = true; log.warn({ server, failures: health.failures }, "Owner told an MCP server is down"); }
    }, (err: unknown) => {
      log.warn({ server, error: shortErrorMessage(err) }, "Could not send the MCP failure notice");
    }).finally(() => { health.noticeSending = false; });
  }
}
