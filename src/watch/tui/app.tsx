import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { WatchClient } from "../client.js";
import {
  applyEvent,
  applySnapshot,
  initialState,
  pushNotice,
  setConnectionState,
  type WatchState,
} from "./model.js";
import { Header } from "./header.js";
import { Feed } from "./feed.js";
import { Sidebar } from "./sidebar.js";
import { LogTail } from "./log-tail.js";

const SIDEBAR_WIDTH = 32;
const MIN_COLS_FOR_SIDEBAR = 80;
const IDLE_TICK_MS = 15_000;
const BUSY_TICK_MS = 1000;

export interface AppProps {
  socketPath: string;
  logPath: string;
}

function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  // `|| fallback` (not ??): some ptys report 0×0, which must not collapse
  // the layout to nothing.
  const read = () => ({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);
  return size;
}

export function App({ socketPath, logPath }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [state, setState] = useState<WatchState>(initialState);
  const [now, setNow] = useState(Date.now());
  const [chatDraft, setChatDraft] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [hideGroups, setHideGroups] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const clientRef = useRef<WatchClient | null>(null);

  useEffect(() => {
    const client = new WatchClient(socketPath, {
      onSnapshot: (snapshot) => setState((s) => applySnapshot(s, snapshot)),
      onEvent: (event) => setState((s) => applyEvent(s, event)),
      onState: (conn) => setState((s) => setConnectionState(s, conn)),
      onSendResult: (ok, error) => {
        if (!ok) setState((s) => pushNotice(s, `send failed: ${error ?? "unknown error"}`));
      },
    });
    clientRef.current = client;
    client.start();
    return () => client.stop();
  }, [socketPath]);

  // Clock/elapsed tick: fast while a turn is in flight, slow when idle —
  // this TUI is designed to sit open 24/7 without burning CPU.
  const busy = Object.keys(state.inFlight).length > 0;
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), busy ? BUSY_TICK_MS : IDLE_TICK_MS);
    return () => clearInterval(timer);
  }, [busy]);

  const submitChat = useCallback((draft: string) => {
    const text = draft.trim();
    if (!text) return;
    const sent = clientRef.current?.send(text) ?? false;
    if (!sent) setState((s) => pushNotice(s, "send failed: not connected to the daemon"));
  }, []);

  useInput((input, key) => {
    if (chatDraft !== null) {
      if (key.return) {
        submitChat(chatDraft);
        setChatDraft(null);
      } else if (key.escape) {
        setChatDraft(null);
      } else if (key.backspace || key.delete) {
        setChatDraft((d) => (d ?? "").slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setChatDraft((d) => (d ?? "") + input);
      }
      return;
    }

    if (input === "q") { exit(); return; }
    if (key.return || input === "i" || input === "/") { setChatDraft(""); return; }
    if (input === "f" || key.escape) { setScrollOffset(0); return; }
    if (input === "l") { setShowLogs((v) => !v); return; }
    if (input === "g") { setHideGroups((v) => !v); return; }
    if (input === "r") { clientRef.current?.refresh(); return; }
    if (input === "?") { setShowHelp((v) => !v); return; }
    if (key.upArrow) setScrollOffset((o) => Math.min(state.feed.length, o + 1));
    if (key.downArrow) setScrollOffset((o) => Math.max(0, o - 1));
    if (key.pageUp) setScrollOffset((o) => Math.min(state.feed.length, o + 10));
    if (key.pageDown) setScrollOffset((o) => Math.max(0, o - 10));
  });

  const contentHeight = Math.max(3, rows - 2); // minus header + footer
  const showSidebar = columns >= MIN_COLS_FOR_SIDEBAR && !showHelp;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header state={state} now={now} />
      <Box flexGrow={1} height={contentHeight}>
        {showHelp ? (
          <HelpPane />
        ) : showLogs ? (
          <LogTail path={logPath} height={contentHeight} />
        ) : (
          <Feed state={state} height={contentHeight} scrollOffset={scrollOffset} hideGroups={hideGroups} now={now} />
        )}
        {showSidebar ? <Sidebar state={state} now={now} width={SIDEBAR_WIDTH} /> : null}
      </Box>
      <FooterLine chatDraft={chatDraft} scrollOffset={scrollOffset} showLogs={showLogs} hideGroups={hideGroups} />
    </Box>
  );
}

function FooterLine({ chatDraft, scrollOffset, showLogs, hideGroups }: {
  chatDraft: string | null;
  scrollOffset: number;
  showLogs: boolean;
  hideGroups: boolean;
}): React.JSX.Element {
  if (chatDraft !== null) {
    return (
      <Box>
        <Text color="cyan" bold>{" › "}</Text>
        <Text>{chatDraft}</Text>
        <Text inverse> </Text>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text dimColor>⏎ send · esc cancel </Text>
        </Box>
      </Box>
    );
  }
  return (
    <Box>
      <Text dimColor>
        {" ⏎ talk · ↑↓ scroll · [f]ollow · [l]ogs"}
        {showLogs ? " (on)" : ""}
        {" · [g]roups"}
        {hideGroups ? " (hidden)" : ""}
        {" · [r]efresh · [?] help · [q]uit"}
      </Text>
      <Box flexGrow={1} justifyContent="flex-end">
        <Text color={scrollOffset === 0 ? "green" : "yellow"}>{scrollOffset === 0 ? "⏷ live " : "⏸ scrolled "}</Text>
      </Box>
    </Box>
  );
}

function HelpPane(): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
      <Text bold>tomo watch — keys</Text>
      <Text> </Text>
      <Text>  ⏎ / i / /   open the chat line (message goes to your dm session)</Text>
      <Text>  ↑ ↓ PgUp PgDn  scroll the feed</Text>
      <Text>  f / esc        jump back to live tail</Text>
      <Text>  l              toggle raw daemon log tail</Text>
      <Text>  g              hide/show group-chat traffic</Text>
      <Text>  r              reconnect + refresh vitals snapshot</Text>
      <Text>  ?              close this help</Text>
      <Text>  q              quit (the daemon keeps running)</Text>
      <Text> </Text>
      <Text dimColor>  The TUI is a read-only window plus a chat line — closing it never affects Tomo.</Text>
    </Box>
  );
}
