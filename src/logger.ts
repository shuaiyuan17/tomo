import pino from "pino";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { watchBus } from "./watch/bus.js";
import { LOG_REDACT_PATHS, redactLogRecord, redactSerializedError, scrubSecretValues } from "./redact.js";

// Blank is unset here too: `TOMO_LOG_FILE="  "` is truthy as a string and
// would have opened a whitespace-named file in the working directory.
const logFile = process.env.TOMO_LOG_FILE?.trim() || undefined;

/**
 * LOG INLINE — NO TRANSPORT WORKER. Set by `vitest.config.ts` for the test
 * run; nothing sets it in production.
 *
 * Every pino transport is a worker thread, and pino registers a
 * `process.on("exit")` teardown hook per transport (`pino/lib/transport.js`
 * buildStream). Vitest gives each test file a fresh module registry inside
 * ONE worker process, so this module is evaluated once per file: the eleventh
 * evaluation tripped `MaxListenersExceededWarning: 11 exit listeners added to
 * [process]`, with a hundred-odd worker threads and their hooks behind it.
 *
 * A direct destination has neither. Everything that shapes a record —
 * `redact.paths`, the `formatters.log` pass, the `err` serializer, the
 * logMethod hook that feeds the watch bus — lives in the options below and is
 * untouched by this, so what the tests exercise is the same logger; only
 * where the bytes land differs. `TOMO_LOG_FILE` is still honoured (the
 * redaction tests read the file back), and without it the records are
 * discarded, which is what already happened in practice: the transport worker
 * is torn down at the end of a file before it flushes.
 *
 * The switch is OURS, not the runner's. Keying off `VITEST` made a foreign
 * variable — one vitest sets, renames or drops on its own schedule, and one
 * any other process is free to export — decide how the daemon logs. A
 * project-owned name says who asked for it and can be set by anything else
 * that wants an in-process logger (a debugger, an embedding host) without
 * pretending to be a test runner.
 */
const logInline = process.env.TOMO_LOG_INLINE !== undefined;

// When running as daemon, log to file; otherwise pretty-print to stdout
const transport = logInline
  ? undefined
  : logFile
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

/** In-process stand-in for the transport, used only when `logInline`. */
const destination: pino.DestinationStream | undefined = !logInline
  ? undefined
  : logFile
    ? (() => {
        mkdirSync(dirname(logFile), { recursive: true });
        return pino.destination({ dest: logFile, sync: true });
      })()
    : { write: () => { /* discard */ } };

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
  // SCRUB BEFORE PUBLISHING. The string args have already been scrubbed in
  // place by the logMethod hook below, but an Error's `message` has not: the
  // `err` serializer only runs on the pino record, not on the value this
  // function reads, and grammY's errors echo the request URL —
  // `https://api.telegram.org/bot<token>/sendMessage` — verbatim. That went
  // out to every `tomo watch` client and into metrics/activity.ndjson, which
  // is a file on disk that ends up in bug reports. Scrub first, then clip, so
  // a token cannot survive by sitting past the 300th character.
  const msg = scrubSecretValues(parts.join(" — ").trim());
  return (msg || "(no message)").slice(0, 300);
}

export const log = pino({
  // A blank LOG_LEVEL is unset, not a level: pino throws on "" at import,
  // which kills the daemon before it can say why. (config.ts envVar has the
  // same rule; this module cannot import it.)
  level: process.env.LOG_LEVEL?.trim() || "debug",
  // Mutually exclusive with the `destination` stream below — pino refuses
  // both at once.
  ...(transport ? { transport } : {}),
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
}, destination);
