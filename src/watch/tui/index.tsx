import React from "react";
import { render } from "ink";
import { App } from "./app.js";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

/** Run the full-screen watch TUI until the user quits. */
export async function runWatchTui(socketPath: string, logPath: string): Promise<void> {
  // Alternate screen buffer: the TUI owns the whole terminal while open and
  // restores the user's scrollback on exit.
  process.stdout.write(ENTER_ALT_SCREEN);
  const restore = () => process.stdout.write(LEAVE_ALT_SCREEN);
  process.on("exit", restore);

  try {
    const { waitUntilExit } = render(<App socketPath={socketPath} logPath={logPath} />, {
      exitOnCtrlC: true,
    });
    await waitUntilExit();
  } finally {
    restore();
    process.removeListener("exit", restore);
  }
}
