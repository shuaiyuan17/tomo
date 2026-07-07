import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { oneLine } from "./format.js";

const TAIL_BYTES = 32 * 1024;
const POLL_MS = 1000;

interface LogLine {
  time: number;
  level: number;
  msg: string;
}

/** Read and parse the last chunk of a pino NDJSON log file. */
function readTail(path: string, maxLines: number): LogLine[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf-8").split("\n");
    // Drop the first line: likely torn by the byte-offset cut.
    if (start > 0) lines.shift();
    const parsed: LogLine[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { time?: number; level?: number; msg?: string };
        parsed.push({ time: obj.time ?? 0, level: obj.level ?? 30, msg: obj.msg ?? line });
      } catch {
        parsed.push({ time: 0, level: 30, msg: line });
      }
    }
    return parsed.slice(-maxLines);
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

function levelStyle(level: number): { label: string; color?: string; dim?: boolean } {
  if (level >= 50) return { label: "ERR ", color: "red" };
  if (level >= 40) return { label: "WARN", color: "yellow" };
  if (level >= 30) return { label: "info", dim: false };
  return { label: "dbg ", dim: true };
}

function fmtLogTime(ts: number): string {
  if (!ts) return "--:--:--";
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

export function LogTail({ path, height }: { path: string; height: number }): React.JSX.Element {
  const [lines, setLines] = useState<LogLine[]>(() => readTail(path, height));

  useEffect(() => {
    const timer = setInterval(() => setLines(readTail(path, height)), POLL_MS);
    return () => clearInterval(timer);
  }, [path, height]);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {lines.length === 0 ? <Text dimColor>  no log data at {path}</Text> : null}
      {lines.map((line, i) => {
        const style = levelStyle(line.level);
        return (
          <Box key={`${line.time}-${i}`}>
            <Text dimColor>{fmtLogTime(line.time)} </Text>
            <Text color={style.color} dimColor={style.dim}>{style.label} </Text>
            <Box flexGrow={1}>
              <Text dimColor={line.level < 40} color={style.color} wrap="truncate-end">{oneLine(line.msg)}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
