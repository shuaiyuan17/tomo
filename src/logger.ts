import pino from "pino";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { watchBus } from "./watch/bus.js";

const logFile = process.env.TOMO_LOG_FILE;

// When running as daemon, log to file; otherwise pretty-print to stdout
const transport = logFile
  ? (() => {
      mkdirSync(dirname(logFile), { recursive: true });
      return {
        target: "pino/file",
        options: { destination: logFile, mkdir: true },
      };
    })()
  : {
      target: "pino-pretty",
      options: {
        colorize: true,
        ignore: "pid,hostname",
        translateTime: "HH:MM:ss",
      },
    };

/** Flatten a pino call's args into one short line for the watch feed. */
function issueMessage(args: unknown[]): string {
  const parts: string[] = [];
  for (const arg of args) {
    if (typeof arg === "string") {
      parts.push(arg);
    } else if (arg instanceof Error) {
      parts.push(arg.message);
    } else if (arg && typeof arg === "object" && "err" in arg) {
      const err = (arg as { err: unknown }).err;
      if (err instanceof Error) parts.push(err.message);
      else if (typeof err === "string") parts.push(err);
    }
  }
  const msg = parts.join(" — ").trim();
  return (msg || "(no message)").slice(0, 300);
}

export const log = pino({
  level: process.env.LOG_LEVEL ?? "debug",
  transport,
  hooks: {
    // Tap warn/error so the watch TUI's "last issue" pane works without
    // parsing the log file. The watch bus never logs, so this cannot recurse.
    logMethod(args, method, level) {
      if (level >= 40) {
        watchBus.publish({ type: "issue", level: level >= 50 ? "error" : "warn", msg: issueMessage(args) });
      }
      return method.apply(this, args);
    },
  },
});
