import React from "react";
import { Box, Text } from "ink";
import type { WatchConnectionState } from "../client.js";
import type { WatchState } from "./model.js";
import { fmtClock, fmtUptime } from "./format.js";

const STATE_DOT: Record<WatchConnectionState, { dot: string; color: string; label: string }> = {
  connected: { dot: "●", color: "green", label: "running" },
  connecting: { dot: "◌", color: "yellow", label: "connecting…" },
  offline: { dot: "●", color: "red", label: "daemon offline — retrying" },
};

export function Header({ state, now }: { state: WatchState; now: number }): React.JSX.Element {
  const s = STATE_DOT[state.conn];
  const snap = state.snapshot;
  const hasIssueGlow = state.lastIssue && now - state.lastIssue.ts < 10 * 60_000;

  return (
    <Box justifyContent="space-between">
      <Box>
        <Text bold> tomo </Text>
        <Text color={hasIssueGlow && state.conn === "connected" ? "yellow" : s.color}>{s.dot} </Text>
        <Text dimColor>{s.label}</Text>
        {snap && state.conn === "connected" ? (
          <Text dimColor>
            {" "}{fmtUptime(now - snap.startedAt)} · {snap.channels.join(" ") || "no channels"} · {snap.model} · v{snap.version}
          </Text>
        ) : null}
      </Box>
      <Text dimColor>{fmtClock(now)} </Text>
    </Box>
  );
}
