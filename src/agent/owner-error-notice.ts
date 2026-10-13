import { log } from "../logger.js";
import { classifyTurnError, type TurnErrorClass } from "./api-errors.js";

/**
 * OWNER NOTICES FOR ERRORS KEPT OUT OF A CHAT.
 *
 * Some turns fail where the failure is not shown: a passive group (the group
 * never asked for Tomo, and an `[error] …` line there is noise or a leak),
 * scheduled/background turns on a group, silent housekeeping turns and
 * heartbeats on the owner's own DM. Those policies keep the error out of the
 * chat (at most a pending note for the session's next turn), so a group
 * refused by the safety classifier on every turn, or every heartbeat and
 * housekeeping turn failing on an expired login, went unnoticed until the
 * owner happened to look at the logs.
 *
 * This sends the owner a short DM instead: which session, what kind of
 * failure, a one-line excerpt, and how to recover. Rate-limited per
 * (session, error class) so a session that fails on every turn produces one
 * notice per window, and the next notice says how many were folded into it.
 *
 * Callers decide eligibility (see Agent.ownerNoticeTarget): only errors the
 * turn's policy held back are reported — an error delivered visibly to a chat
 * is never reported a second time. A group's notice goes to the owner, never
 * to the group.
 */

export const OWNER_NOTICE_WINDOW_MS = 30 * 60 * 1000;
const EXCERPT_MAX_CHARS = 200;

export interface SuppressedErrorReport {
  /** Rate-limit and display key: the GROUP session key the failure belongs
   *  to (for a summoned group, the group's key, not the dm: key it ran on). */
  noticeKey: string;
  /** Human label for the session, e.g. `group "Family" (imessage:…)`. */
  label: string;
  /** What failed, sentence-initial: "A message turn", "Cron job \"x\"". */
  turnKind: string;
  /** The error text (thrown message or agent-error response). */
  detail: string;
  /** SDK session id of the session the turn ran on, for the compact hint. */
  sdkSessionId?: string;
  /** End time (epoch ms) of the session's last successful turn, when this
   *  process has seen one — the start of the range to compact. */
  lastGoodTurnAt?: number;
  /** The turn ran on the owner's dm: session, where /rewind is available. */
  rewindable?: boolean;
  /** dm: session whose own chat receives the notice (the failure happened
   *  there); absent → the owner's default notification target. */
  deliverTo?: string;
}

export interface OwnerErrorNotifierDeps {
  /** Deliver a DM to the owner (Agent.sendNotification). Resolving false
   *  means there was no owner target; it counts as a failed send. */
  send(text: string, report: SuppressedErrorReport): Promise<boolean | void>;
  /** Config gate, read per report so a config reload applies. */
  enabled(): boolean;
  now?: () => number;
  windowMs?: number;
}

interface WindowState {
  lastSentAt: number;
  /** Failures folded into the window since the last notice. */
  dropped: number;
}

const CLASS_LABEL: Record<TurnErrorClass, string> = {
  safeguard: "safety classifier refusal",
  auth: "authentication failure",
  "usage-limit": "usage limit reached",
  other: "error",
};

/** Local wall-clock ISO 8601 with offset, to the second — what
 *  `tomo lcm compact --from-time/--to-time` parses. */
export function localIsoSeconds(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

export function errorExcerpt(detail: string): string {
  const line = detail.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "(no error text)";
  return line.length > EXCERPT_MAX_CHARS ? `${line.slice(0, EXCERPT_MAX_CHARS - 1)}…` : line;
}

function recoveryHint(cls: TurnErrorClass, report: SuppressedErrorReport, failedAt: number): string {
  switch (cls) {
    case "safeguard": {
      const sid = report.sdkSessionId ?? "<session-id>";
      // The failing turn's own prompt is in the range; the last good turn is
      // not (its events all precede the moment it ended).
      const from = report.lastGoodTurnAt !== undefined
        ? localIsoSeconds(report.lastGoodTurnAt)
        : "<time of the last turn that worked>";
      const compact = `compact the range since the last good turn: tomo lcm compact --session-id ${sid} --from-time ${from} --to-time ${localIsoSeconds(failedAt)} --summary "<summary>"`;
      const rewind = report.rewindable ? " — or send /rewind in this DM" : "";
      return `Recovery: ${compact}${rewind}. Until that is done and the session reloads, the next turn there may still be refused.`;
    }
    case "auth":
      // /login is a harness command (ChatCommandHandler), not a model turn,
      // so it works while every model turn is failing on auth.
      return "Recovery: send /login in this DM to refresh the Claude login (handled by Tomo directly, no model turn needed). If that fails, run `claude auth login` on the host.";
    case "usage-limit":
      return "Recovery: wait for the usage window to reset (/usage shows when).";
    default:
      return "Recovery: check the Tomo log (~/.tomo/logs/tomo.log) for details.";
  }
}

export function formatOwnerNotice(report: SuppressedErrorReport, cls: TurnErrorClass, dropped: number, failedAt: number = Date.now()): string {
  const lines = [
    `⚠️ ${report.turnKind} in ${report.label} failed; the error was kept out of that chat.`,
    `Kind: ${CLASS_LABEL[cls]}`,
    `Error: ${errorExcerpt(report.detail)}`,
  ];
  if (dropped > 0) {
    lines.push(`This kind of failure happened ${dropped} more time${dropped === 1 ? "" : "s"} there since the last notice.`);
  }
  lines.push(recoveryHint(cls, report, failedAt));
  return lines.join("\n");
}

export class OwnerErrorNotifier {
  private readonly windows = new Map<string, WindowState>();
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(private readonly deps: OwnerErrorNotifierDeps) {
    this.now = deps.now ?? Date.now;
    this.windowMs = deps.windowMs ?? OWNER_NOTICE_WINDOW_MS;
  }

  /**
   * Report one suppressed failure. Resolves true when a notice was sent,
   * false when disabled, rate-limited, or the send failed. Never rejects.
   */
  async report(report: SuppressedErrorReport): Promise<boolean> {
    if (!this.deps.enabled()) return false;
    const cls = classifyTurnError(report.detail);
    const windowKey = `${report.noticeKey}\u0000${cls}`;
    const now = this.now();
    const prev = this.windows.get(windowKey);
    if (prev && now - prev.lastSentAt < this.windowMs) {
      prev.dropped += 1;
      log.info({ noticeKey: report.noticeKey, errorClass: cls, dropped: prev.dropped }, "Owner error notice rate-limited");
      return false;
    }
    const dropped = prev?.dropped ?? 0;
    // Claimed BEFORE the send, so two failures racing in the same tick
    // cannot both notify.
    this.windows.set(windowKey, { lastSentAt: now, dropped: 0 });
    try {
      const delivered = await this.deps.send(formatOwnerNotice(report, cls, dropped, now), report);
      if (delivered === false) throw new Error("no owner DM target");
      log.info({ noticeKey: report.noticeKey, errorClass: cls }, "Owner notified of a suppressed error");
      return true;
    } catch (err) {
      // Not delivered: give the window back (with this failure counted) so
      // the next failure tries again instead of staying silent for a window.
      const current = this.windows.get(windowKey);
      if (current?.lastSentAt === now) {
        this.windows.set(windowKey, { lastSentAt: Number.NEGATIVE_INFINITY, dropped: dropped + 1 + current.dropped });
      }
      log.warn({ err, noticeKey: report.noticeKey, errorClass: cls }, "Owner error notice could not be delivered");
      return false;
    }
  }
}
