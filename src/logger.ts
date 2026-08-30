import pino from "pino";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { watchBus } from "./watch/bus.js";
import { LOG_REDACT_PATHS } from "./redact.js";

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
  // Second line of defence for credentials. `configIssues` is the surface that
  // actually leaked one (a bad `allowlist` stringified the whole channel entry
  // into `tomo status` and the launchd error log), and that is fixed at the
  // source in config.ts — but nothing stopped a `log.info({ channel }, …)`
  // from putting a bot token in ~/.tomo/logs/tomo.log, and a log file is
  // copied into bug reports. Paths are generated from the same field-name
  // rule; the censor is pino's default `[Redacted]`.
  redact: { paths: LOG_REDACT_PATHS },
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
