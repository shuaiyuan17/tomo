import pino from "pino";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

export const log = pino({
  level: process.env.LOG_LEVEL ?? "debug",
  transport,
});
