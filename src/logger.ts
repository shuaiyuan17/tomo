import pino from "pino";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { watchBus } from "./watch/bus.js";
import { LOG_REDACT_PATHS, redactLogRecord, redactSerializedError, scrubSecretValues } from "./redact.js";

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
  formatters: {
    // Second, general pass over the merged object. `redact.paths` is a ladder
    // of literal paths and can always be out-nested — `{ config: { channels:
    // { telegram: { token } } } }` is four levels deep, an MCP entry nests
    // `mcpServers.<name>.headers.Authorization`. This matches the same names
    // at any depth, and returns the object untouched (no clone) when there is
    // nothing to redact, which is almost every line.
    log: (record) => redactLogRecord(record),
  },
  serializers: {
    // An error object is the other way a credential arrives: grammY puts the
    // bot token in the request URL it echoes, an axios-shaped error carries
    // `config.headers.Authorization` (and `response.data.config.headers…`
    // deeper still), and an AggregateError's sub-errors carry their own
    // messages and stacks. Serialize first, so the stack survives — the deep
    // `formatters.log` pass cannot help here, because it runs BEFORE
    // serializers and so only ever sees a raw Error.
    err: (err: unknown) => redactSerializedError(pino.stdSerializers.err(err as Error)),
  },
  hooks: {
    // Tap warn/error so the watch TUI's "last issue" pane works without
    // parsing the log file. The watch bus never logs, so this cannot recurse.
    logMethod(args, method, level) {
      // The MESSAGE is the one part of a log record that no object-level
      // redaction can reach, and it is where the real exposure lives:
      // live-session.ts logs `summarizeToolResult(...)` — the first 500
      // characters of every tool result — as the message at info, so a single
      // `Read ~/.tomo/config.json` used to write the bot token into
      // ~/.tomo/logs/tomo.log. There is no key to match on in a free-text
      // string, so this matches on the shape of the value instead.
      for (let i = 0; i < args.length; i++) {
        if (typeof args[i] === "string") args[i] = scrubSecretValues(args[i] as string);
      }
      if (level >= 40) {
        watchBus.publish({ type: "issue", level: level >= 50 ? "error" : "warn", msg: issueMessage(args) });
      }
      return method.apply(this, args);
    },
  },
});
