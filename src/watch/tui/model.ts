import { isSilentReply, stripTrailingNoReply } from "../../agent/text-utils.js";
import type { WatchConnectionState } from "../client.js";
import type { TurnSource, WatchEvent, WatchIssue, WatchSnapshot } from "../protocol.js";

/**
 * Pure state logic for the `tomo watch` TUI: fold snapshot + live events into
 * a renderable state. No Ink imports — fully unit-testable.
 */

export type FeedKind =
  | "user"
  | "assistant"
  | "tool"
  | "turn"
  | "cron"
  | "heartbeat"
  | "compact"
  | "issue"
  | "notice";

export interface FeedItem {
  id: number;
  ts: number;
  kind: FeedKind;
  /** Main line content (already includes sender labels etc.). */
  text: string;
  /** Dim suffix — durations, cost, channel. */
  meta?: string;
  sessionKey?: string;
  /** For tool/cron items that resolve later. */
  status?: "pending" | "ok" | "error";
  /** Matching key for tool.end / cron.done updates. */
  matchKey?: string;
  isGroup?: boolean;
}

export interface InFlightTurn {
  sessionKey: string;
  source: TurnSource;
  startedAt: number;
  /** Label of the most recent tool.start inside this turn. */
  activity?: string;
}

export interface WatchState {
  conn: WatchConnectionState;
  snapshot: WatchSnapshot | null;
  feed: FeedItem[];
  /** In-flight turns by session key — sessions run turns concurrently. */
  inFlight: Record<string, InFlightTurn>;
  /** turn.stats arrives BEFORE turn.end (stats are recorded when the SDK
   *  query resolves, the turn ends after delivery) — stash per session until
   *  the turn.end feed row exists to attach them to. */
  pendingStats: Record<string, { costUsd: number; contextUsed: number; contextMax: number }>;
  contextUsed: number;
  contextMax: number;
  costTodayUsd: number;
  turnsToday: number;
  lastIssue: WatchIssue | null;
  nextId: number;
}

export const FEED_LIMIT = 400;

export function initialState(): WatchState {
  return {
    conn: "connecting",
    snapshot: null,
    feed: [],
    inFlight: {},
    pendingStats: {},
    contextUsed: 0,
    contextMax: 0,
    costTodayUsd: 0,
    turnsToday: 0,
    lastIssue: null,
    nextId: 1,
  };
}

function isGroupKey(sessionKey: string | undefined): boolean {
  if (!sessionKey) return false;
  // Mirrors sessions/keys.ts heuristics without importing config-touching code.
  const idx = sessionKey.indexOf(":");
  if (idx === -1) return false;
  const chatId = sessionKey.slice(idx + 1);
  return chatId.startsWith("-") || chatId.includes(";+;");
}

function pushItem(state: WatchState, item: Omit<FeedItem, "id">): WatchState {
  const feed = [...state.feed, { ...item, id: state.nextId }];
  if (feed.length > FEED_LIMIT) feed.splice(0, feed.length - FEED_LIMIT);
  return { ...state, feed, nextId: state.nextId + 1 };
}

/** Update the newest feed item matching `matchKey` that is still pending. */
function resolveItem(
  state: WatchState,
  matchKey: string,
  status: "ok" | "error",
  extraMeta?: string,
): WatchState {
  for (let i = state.feed.length - 1; i >= 0; i--) {
    const item = state.feed[i];
    if (item.matchKey === matchKey && item.status === "pending") {
      const feed = [...state.feed];
      feed[i] = {
        ...item,
        status,
        meta: [item.meta, extraMeta].filter(Boolean).join(" · ") || undefined,
      };
      return { ...state, feed };
    }
  }
  return state;
}

/** ` · $0.0410 · ctx 42%` suffix for a turn row. */
function statsMeta(stats: { costUsd: number; contextUsed: number; contextMax: number }): string {
  const pct = stats.contextMax > 0 ? ` · ctx ${Math.round((stats.contextUsed / stats.contextMax) * 100)}%` : "";
  return ` · $${stats.costUsd.toFixed(4)}${pct}`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Fold one live event into the state. `backfill` marks snapshot-replay
 * events whose costs/turn counts are already inside the snapshot totals —
 * they build feed items but must not double-count vitals.
 */
export function applyEvent(state: WatchState, event: WatchEvent, backfill = false): WatchState {
  switch (event.type) {
    case "transcript": {
      const group = isGroupKey(event.sessionKey);
      if (event.role === "assistant") {
        const { visible } = stripTrailingNoReply(event.text);
        if (isSilentReply(event.text) || visible.length === 0) {
          return pushItem(state, {
            ts: event.ts,
            kind: "notice",
            text: "tomo stayed quiet (NO_REPLY)",
            sessionKey: event.sessionKey,
            isGroup: group,
          });
        }
        return pushItem(state, {
          ts: event.ts,
          kind: "assistant",
          text: visible,
          meta: `→ ${event.channel}`,
          sessionKey: event.sessionKey,
          isGroup: group,
        });
      }
      return pushItem(state, {
        ts: event.ts,
        kind: "user",
        text: event.text,
        meta: `${event.sender ? `${event.sender} · ` : ""}${event.channel}`,
        sessionKey: event.sessionKey,
        isGroup: group,
      });
    }

    case "turn.start": {
      // A fresh turn on this session invalidates any stats stash left by a
      // previous turn that ended without consuming it (thrown errors).
      const pendingStats = { ...state.pendingStats };
      delete pendingStats[event.sessionKey];
      return {
        ...state,
        pendingStats,
        inFlight: {
          ...state.inFlight,
          [event.sessionKey]: { sessionKey: event.sessionKey, source: event.source, startedAt: event.ts },
        },
      };
    }

    case "turn.end": {
      const inFlight = { ...state.inFlight };
      delete inFlight[event.sessionKey];
      const stats = state.pendingStats[event.sessionKey];
      const pendingStats = { ...state.pendingStats };
      delete pendingStats[event.sessionKey];
      let next: WatchState = {
        ...state,
        inFlight,
        pendingStats,
        turnsToday: backfill ? state.turnsToday : state.turnsToday + 1,
      };
      next = pushItem(next, {
        ts: event.ts,
        kind: "turn",
        text: `turn ${event.ok ? "done" : "failed"} (${event.source})`,
        meta: fmtDuration(event.durationMs) + (stats ? statsMeta(stats) : ""),
        sessionKey: event.sessionKey,
        status: event.ok ? "ok" : "error",
        matchKey: `turn:${event.sessionKey}`,
        isGroup: isGroupKey(event.sessionKey),
      });
      return next;
    }

    case "turn.stats": {
      const withVitals: WatchState = {
        ...state,
        contextUsed: event.contextUsed,
        contextMax: event.contextMax,
        costTodayUsd: backfill ? state.costTodayUsd : state.costTodayUsd + event.costUsd,
      };
      // Stats normally precede this turn's turn.end — while a turn is in
      // flight for this session, ALWAYS stash for the row it will create.
      // Scanning the feed here instead would annotate an older same-session
      // row (e.g. a prior turn that failed before its stats fired). Only
      // when nothing is in flight (replayed history with a different
      // interleaving) is annotating an existing row safe.
      if (!withVitals.inFlight[event.sessionKey]) {
        for (let i = withVitals.feed.length - 1; i >= 0; i--) {
          const item = withVitals.feed[i];
          if (item.matchKey === `turn:${event.sessionKey}` && item.kind === "turn" && !item.meta?.includes("$")) {
            const feed = [...withVitals.feed];
            feed[i] = { ...item, meta: `${item.meta ?? ""}${statsMeta(event)}` };
            return { ...withVitals, feed };
          }
        }
      }
      return {
        ...withVitals,
        pendingStats: {
          ...withVitals.pendingStats,
          [event.sessionKey]: { costUsd: event.costUsd, contextUsed: event.contextUsed, contextMax: event.contextMax },
        },
      };
    }

    case "tool.start": {
      const current = event.sessionKey ? state.inFlight[event.sessionKey] : undefined;
      const withActivity = current
        ? {
          ...state,
          inFlight: {
            ...state.inFlight,
            [current.sessionKey]: { ...current, activity: `${event.agent ? `${event.agent} · ` : ""}${event.detail ?? event.tool}` },
          },
        }
        : state;
      return pushItem(withActivity, {
        ts: event.ts,
        kind: "tool",
        text: `${event.agent ? `${event.agent} · ` : ""}${event.detail ?? event.tool}`,
        sessionKey: event.sessionKey,
        status: "pending",
        matchKey: `tool:${event.sessionKey ?? ""}:${event.tool}`,
        isGroup: isGroupKey(event.sessionKey),
      });
    }

    case "tool.end":
      return resolveItem(
        state,
        `tool:${event.sessionKey ?? ""}:${event.tool}`,
        event.ok ? "ok" : "error",
        event.durationMs !== undefined ? fmtDuration(event.durationMs) : undefined,
      );

    case "cron.fired":
      return pushItem(state, {
        ts: event.ts,
        kind: "cron",
        text: `cron: ${event.name}`,
        status: "pending",
        matchKey: `cron:${event.jobId}`,
      });

    case "cron.done":
      return resolveItem(state, `cron:${event.jobId}`, event.ok ? "ok" : "error");

    case "heartbeat":
      return pushItem(state, { ts: event.ts, kind: "heartbeat", text: "continuity heartbeat" });

    case "compact":
      return pushItem(state, {
        ts: event.ts,
        kind: "compact",
        text: "context compacted",
        meta: event.preTokens !== undefined && event.postTokens !== undefined
          ? `${event.preTokens} → ${event.postTokens} tokens`
          : undefined,
        sessionKey: event.sessionKey,
        isGroup: isGroupKey(event.sessionKey),
      });

    case "issue":
      return pushItem(
        { ...state, lastIssue: event },
        { ts: event.ts, kind: "issue", text: event.msg, status: event.level === "error" ? "error" : undefined },
      );

    default:
      return state;
  }
}

/**
 * A (re)connect delivered a fresh snapshot: rebuild the feed from its recent
 * events and reset vitals to the snapshot's authoritative totals.
 */
export function applySnapshot(state: WatchState, snapshot: WatchSnapshot): WatchState {
  let next: WatchState = {
    ...initialState(),
    conn: "connected",
    nextId: state.nextId,
    snapshot,
    costTodayUsd: snapshot.costTodayUsd,
    turnsToday: snapshot.turnsToday,
    lastIssue: snapshot.lastIssue,
  };

  // Context gauge: prefer the dm session's stats; else the most recent session.
  const sessions = [...snapshot.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  const primary = sessions.find((s) => s.key.startsWith("dm:")) ?? sessions[0];
  if (primary) {
    next.contextUsed = primary.contextUsed;
    next.contextMax = primary.contextMax;
  }

  for (const event of snapshot.recent) {
    next = applyEvent(next, event, true);
  }

  // A turn.start at the ring edge without its turn.end would pin a stale
  // "in flight" indicator forever; only trust recent ones.
  const fresh = Object.entries(next.inFlight)
    .filter(([, turn]) => Date.now() - turn.startedAt <= 15 * 60_000);
  if (fresh.length !== Object.keys(next.inFlight).length) {
    next = { ...next, inFlight: Object.fromEntries(fresh) };
  }

  return next;
}

/** Local TUI notices (send failures etc.) — not daemon events. */
export function pushNotice(state: WatchState, text: string): WatchState {
  return pushItem(state, { ts: Date.now(), kind: "notice", text });
}

export function setConnectionState(state: WatchState, conn: WatchConnectionState): WatchState {
  return state.conn === conn ? state : { ...state, conn };
}

/** Display title for a session key, using snapshot chat titles when known. */
export function sessionLabel(state: WatchState, sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  const entry = state.snapshot?.sessions.find((s) => s.key === sessionKey);
  return entry?.chatTitle ?? sessionKey;
}
