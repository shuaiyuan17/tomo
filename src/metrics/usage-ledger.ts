import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";
import type { ModelTurnUsage } from "../agent/sdk-result.js";
import { parseTomoEvent } from "../tomo-event.js";

/**
 * Usage ledger: one NDJSON line per SDK result, appended to
 * `<dir>/YYYY-MM.ndjson` (local month of the result). Append-only and never
 * rotated — the Study Cost page reads it as its history, so unlike the
 * optional, size-rotated activity log it is always on and kept forever.
 *
 * Bookkeeping only: a failed write is a warn, never a failed turn.
 *
 * Writes are SYNCHRONOUS on purpose: each row is one `appendFileSync` (one
 * O_APPEND write of the whole line) finished before `append` returns, so rows
 * from concurrent sessions can neither interleave nor land out of call order.
 * An async `appendFile` per row gives neither guarantee. Values are written
 * as the SDK reported them (deltas unrounded); rounding is for display.
 */
export const USAGE_LEDGER_VERSION = 1;

/**
 * Who started the turn.
 *  - `owner` / `group`: a message in the owner's DM (web, watch chat
 *    included) / in a group chat;
 *  - `cron`: a scheduled job (`jobId`, `jobName` set);
 *  - `system`: harness-made cron-path turns with no job — LCM rollups,
 *    context nudges, undelivered-reply restates;
 *  - `delegate`: `send_message(mode: "delegate")` from another session;
 *  - `heartbeat` / `restart`: continuity turns;
 *  - `background`: a turn the CLI started itself (a background task's report).
 */
export type UsageSource = "owner" | "group" | "cron" | "system" | "delegate" | "heartbeat" | "restart" | "background";

/** The Cost page's three buckets ("You" / "Background" / "Scheduled"). */
export type UsageCategory = "you" | "background" | "scheduled";

export function usageCategory(source: UsageSource): UsageCategory {
  switch (source) {
    case "owner":
    case "group":
      return "you";
    case "cron":
    case "system":
    case "delegate":
      return "scheduled";
    default:
      return "background";
  }
}

/** What the turn's caller knows about it; rides on ReplyContext into LiveSession. */
export interface UsageAttribution {
  source: UsageSource;
  jobId?: string;
  jobName?: string;
  /** Start of the message that triggered the turn (see triggerSnippet). */
  trigger?: string;
}

export interface UsageLedgerRow {
  v: typeof USAGE_LEDGER_VERSION;
  /** ms epoch when the result arrived. */
  ts: number;
  sessionKey: string;
  source: UsageSource;
  jobId?: string;
  jobName?: string;
  /** Web request id, when the turn answers one. */
  requestId?: string;
  trigger?: string;
  /** Result subtype when it was not `success`. */
  subtype?: string;
  /** This turn's estimated cost (delta of the SDK's cumulative total). */
  costUsd: number;
  tokens: { input: number; output: number; cacheRead: number; cacheCreated: number };
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  /**
   * First result after a resume with no usable baseline: `costUsd` is 0 and
   * `tokens` are the main loop's only — an undercount, not a measurement.
   */
  noBaseline?: true;
  /**
   * This turn per model. Absent when it cannot be split: no `modelUsage` on
   * the result, `noBaseline`, or a resume from a baseline written before
   * per-model usage existed.
   */
  models?: Record<string, ModelTurnUsage>;
}

export const TRIGGER_MAX_CHARS = 80;

/**
 * The first TRIGGER_MAX_CHARS characters of a turn's prompt, for "the most
 * expensive turns". A harness envelope (`<tomo-event>`) is unwrapped to its
 * body so a cron turn reads as its task, not as markup.
 */
export function triggerSnippet(prompt: string): string | undefined {
  const text = (parseTomoEvent(prompt)?.body ?? prompt).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const chars = Array.from(text);
  return chars.length > TRIGGER_MAX_CHARS ? chars.slice(0, TRIGGER_MAX_CHARS).join("") : text;
}

/** `YYYY-MM.ndjson` for the local month of `ts`. */
export function ledgerFileName(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}.ndjson`;
}

export type UsageRecorder = (row: UsageLedgerRow) => void;

export class UsageLedger {
  private dirReady = false;
  /** After a failure, warn once until a write succeeds again. */
  private failing = false;

  constructor(private readonly dir: string) {}

  /** Never throws. */
  append(row: UsageLedgerRow): void {
    try {
      if (!this.dirReady) {
        mkdirSync(this.dir, { recursive: true });
        this.dirReady = true;
      }
      appendFileSync(join(this.dir, ledgerFileName(row.ts)), `${JSON.stringify(row)}\n`);
      this.failing = false;
    } catch (err) {
      // A deleted directory comes back on the next try.
      this.dirReady = false;
      if (!this.failing) {
        this.failing = true;
        log.warn({ err, dir: this.dir, sessionKey: row.sessionKey }, "Could not write the usage ledger; this turn's usage is not recorded");
      }
    }
  }
}
