import React from "react";
import { Box, Text } from "ink";
import type { WatchState } from "./model.js";
import { fmtAgo, fmtCost, fmtEta, gauge } from "./format.js";

function SectionTitle({ children }: { children: string }): React.JSX.Element {
  return <Text bold dimColor>{children}</Text>;
}

export function Sidebar({ state, now, width }: { state: WatchState; now: number; width: number }): React.JSX.Element {
  const snap = state.snapshot;

  const upcoming: Array<{ ts: number; label: string }> = [];
  if (snap) {
    for (const job of snap.cron) {
      if (job.enabled && job.nextRunAt !== null) upcoming.push({ ts: job.nextRunAt, label: job.name });
    }
    if (snap.nextHeartbeatAt !== null) upcoming.push({ ts: snap.nextHeartbeatAt, label: "heartbeat" });
    upcoming.sort((a, b) => a.ts - b.ts);
  }

  return (
    <Box flexDirection="column" width={width} paddingLeft={1} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor="gray">
      <SectionTitle>VITALS</SectionTitle>
      <Text>
        context  <Text color={contextColor(state)}>{gauge(state.contextUsed, state.contextMax)}</Text>
      </Text>
      <Text>cost     {fmtCost(state.costTodayUsd)} 24h · {snap ? fmtCost(snap.costWeekUsd) : "—"} 7d</Text>
      <Text>turns    {state.turnsToday} in 24h</Text>
      <Text> </Text>

      <SectionTitle>NEXT UP</SectionTitle>
      {upcoming.length === 0 ? <Text dimColor>  nothing scheduled</Text> : null}
      {upcoming.slice(0, 5).map((u) => (
        <Box key={`${u.ts}-${u.label}`}>
          <Text dimColor>{fmtEta(u.ts, now).padStart(5)} </Text>
          <Text wrap="truncate-end"> {u.label}</Text>
        </Box>
      ))}
      <Text> </Text>

      <SectionTitle>LAST ISSUE</SectionTitle>
      {state.lastIssue ? (
        <Box flexDirection="column">
          <Text color={state.lastIssue.level === "error" ? "red" : "yellow"} wrap="truncate-end">
            {state.lastIssue.msg}
          </Text>
          <Text dimColor>{fmtAgo(state.lastIssue.ts, now)}</Text>
        </Box>
      ) : (
        <Text dimColor>  none 🎉</Text>
      )}
    </Box>
  );
}

function contextColor(state: WatchState): string | undefined {
  if (state.contextMax <= 0) return undefined;
  const pct = state.contextUsed / state.contextMax;
  if (pct >= 0.8) return "red";
  if (pct >= 0.7) return "yellow";
  return "green";
}
