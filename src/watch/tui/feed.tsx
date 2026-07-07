import React from "react";
import { Box, Text } from "ink";
import type { FeedItem, InFlightTurn, WatchState } from "./model.js";
import { sessionLabel } from "./model.js";
import { elapsedSeconds, fmtClock, oneLine } from "./format.js";

const KIND_ICON: Record<FeedItem["kind"], string> = {
  user: "▸",
  assistant: "◂",
  tool: "⚙",
  turn: "·",
  cron: "⏰",
  heartbeat: "♥",
  compact: "▣",
  issue: "⚠",
  notice: "·",
};

function itemColor(item: FeedItem): string | undefined {
  switch (item.kind) {
    case "user": return "cyan";
    case "assistant": return undefined; // default foreground — Tomo's words are the content
    case "issue": return item.status === "error" ? "red" : "yellow";
    case "cron": return "magenta";
    default: return "gray";
  }
}

function statusMark(item: FeedItem): { mark: string; color: string } | null {
  if (item.status === "pending") return { mark: "…", color: "gray" };
  if (item.status === "ok") return { mark: "✓", color: "green" };
  if (item.status === "error") return { mark: "✗", color: "red" };
  return null;
}

function FeedLine({ item, state }: { item: FeedItem; state: WatchState }): React.JSX.Element {
  const color = itemColor(item);
  const dim = item.kind === "tool" || item.kind === "turn" || item.kind === "heartbeat"
    || item.kind === "compact" || item.kind === "notice";
  const mark = statusMark(item);
  const groupTag = item.isGroup ? sessionLabel(state, item.sessionKey) : undefined;

  return (
    <Box>
      <Text dimColor wrap="truncate">{fmtClock(item.ts)} </Text>
      <Text color={color} dimColor={dim}>{KIND_ICON[item.kind]} </Text>
      <Box flexGrow={1}>
        <Text color={color} dimColor={dim} wrap="truncate-end">
          {groupTag ? `[${oneLine(groupTag, 24)}] ` : ""}
          {oneLine(item.text)}
          {item.meta ? <Text dimColor>  {item.meta}</Text> : null}
          {mark ? <Text color={mark.color}> {mark.mark}</Text> : null}
        </Text>
      </Box>
    </Box>
  );
}

function InFlightLine({ turn, state, now }: { turn: InFlightTurn; state: WatchState; now: number }): React.JSX.Element {
  const label = sessionLabel(state, turn.sessionKey);
  return (
    <Box>
      <Text color="yellow">
        ✦ turn in flight ({turn.source}{label && !turn.sessionKey.startsWith("dm:") ? ` · ${label}` : ""}) · {elapsedSeconds(turn.startedAt, now)}
      </Text>
      {turn.activity ? (
        <Box flexGrow={1}>
          <Text dimColor wrap="truncate-end">  └ {oneLine(turn.activity)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export interface FeedProps {
  state: WatchState;
  height: number;
  /** 0 = follow the tail; >0 = scrolled up by that many items. */
  scrollOffset: number;
  hideGroups: boolean;
  now: number;
}

export function Feed({ state, height, scrollOffset, hideGroups, now }: FeedProps): React.JSX.Element {
  const items = hideGroups ? state.feed.filter((i) => !i.isGroup) : state.feed;
  const inFlight = Object.values(state.inFlight).sort((a, b) => a.startedAt - b.startedAt);
  const pinned = scrollOffset === 0 ? inFlight.length : 0;
  const visibleCount = Math.max(1, height - pinned);
  const end = Math.max(0, items.length - scrollOffset);
  const start = Math.max(0, end - visibleCount);
  const visible = items.slice(start, end);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.length === 0 && inFlight.length === 0 ? (
        <Text dimColor>  waiting for activity…</Text>
      ) : null}
      {visible.map((item) => (
        <FeedLine key={item.id} item={item} state={state} />
      ))}
      {scrollOffset === 0
        ? inFlight.map((turn) => <InFlightLine key={turn.sessionKey} turn={turn} state={state} now={now} />)
        : null}
      {scrollOffset > 0 ? (
        <Text dimColor>── scrolled ({scrollOffset} back) — [f] to follow ──</Text>
      ) : null}
    </Box>
  );
}
