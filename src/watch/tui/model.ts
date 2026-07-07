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
  inFlight: InFlightTurn | null;
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
    inFlight: null,
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

    case "turn.start":
      return {
        ...state,
        inFlight: { sessionKey: event.sessionKey, source: event.source, startedAt: event.ts },
      };

    case "turn.end": {
      let next: WatchState = {
        ...state,
        inFlight: null,
        turnsToday: backfill ? state.turnsToday : state.turnsToday + 1,
      };
      next = pushItem(next, {
        ts: event.ts,
        kind: "turn",
        text: `turn ${event.ok ? "done" : "failed"} (${event.source})`,
        meta: fmtDuration(event.durationMs),
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
      // Attach cost/context to the newest turn line for this session.
      for (let i = withVitals.feed.length - 1; i >= 0; i--) {
        const item = withVitals.feed[i];
        if (item.matchKey === `turn:${event.sessionKey}` && item.kind === "turn") {
          const pct = event.contextMax > 0 ? ` · ctx ${Math.round((event.contextUsed / event.contextMax) * 100)}%` : "";
          const feed = [...withVitals.feed];
          feed[i] = { ...item, meta: `${item.meta ?? ""} · $${event.costUsd.toFixed(4)}${pct}` };
          return { ...withVitals, feed };
        }
      }
      return withVitals;
    }

    case "tool.start":
      return pushItem(
        state.inFlight
          ? { ...state, inFlight: { ...state.inFlight, activity: `${event.agent ? `${event.agent} · ` : ""}${event.detail ?? event.tool}` } }
          : state,
        {
          ts: event.ts,
          kind: "tool",
          text: `${event.agent ? `${event.agent} · ` : ""}${event.detail ?? event.tool}`,
          sessionKey: event.sessionKey,
          status: "pending",
          matchKey: `tool:${event.sessionKey ?? ""}:${event.tool}`,
          isGroup: isGroupKey(event.sessionKey),
        },
      );

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
  if (next.inFlight && Date.now() - next.inFlight.startedAt > 15 * 60_000) {
    next = { ...next, inFlight: null };
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
