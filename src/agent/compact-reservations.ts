import { randomUUID } from "node:crypto";
import { log } from "../logger.js";

/**
 * Per-session "a compact is pending" reservations — the daemon half of the
 * rollup gate (see lcm/background-gate.ts).
 *
 * A session-file rewrite is followed by a reload that closes the live session
 * and kills its background tasks. Checking "no background tasks" once, before
 * the rewrite, leaves a window: a task launched after the check (later in the
 * same turn, or while the rewrite runs) is still killed by the reload. So the
 * check and a mark are ONE synchronous step here (`reserve`), and while the
 * mark stands every new background launch on that session is denied by a
 * PreToolUse hook (`launchDenial`). The mark lives from the approval until the
 * reload, and can never outlive its purpose:
 *
 * - `finish` after the rewrite: no reload pending (the rewrite failed or never
 *   happened) releases it at once; a pending reload keeps it until `clear`.
 * - `clear` when the session reloads after the compact.
 * - a TTL on each phase, so a crashed or hung CLI cannot lock the session.
 *
 * The opposite race is covered too: a launch the hook allowed can take a
 * moment to show up in the SDK's background set, so `reserve` also refuses for
 * a short settle window after any allowed launch.
 */

/** A reserved rewrite that never reports back is released after this. */
export const COMPACT_RESERVATION_REWRITE_TTL_MS = 10 * 60 * 1000;
/** A rewritten session whose reload never happens is released after this. */
export const COMPACT_RESERVATION_RELOAD_TTL_MS = 60 * 60 * 1000;
/** After an allowed background launch, refuse reservations this long. */
export const BACKGROUND_LAUNCH_SETTLE_MS = 30 * 1000;

export const BACKGROUND_LAUNCH_DENIAL =
  "A context rollup/compact is pending on this session, and the session reloads when it finishes — " +
  "a background task started now would be killed by that reload. Run this in the foreground instead, " +
  "or launch it after the reload (normally at the end of this turn).";

/** What the session is doing in the background, as the reservation sees it. */
export interface BackgroundState {
  activeBackgroundTasks: number;
  /** Background set drained, the SDK's follow-up report turn not yet started. */
  awaitingTaskReport: boolean;
}

export type ReserveResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: "background-tasks" | "awaiting-task-report" | "recent-launch" | "already-pending"; state: BackgroundState };

interface Reservation {
  id: string;
  sdkSessionId: string;
  phase: "rewriting" | "awaiting-reload";
  timer: ReturnType<typeof setTimeout>;
}

export class CompactReservations {
  private byKey = new Map<string, Reservation>();
  private lastLaunchAt = new Map<string, number>();

  constructor(
    /** Is a compact trigger (a pending reload) on disk for this SDK session? */
    private readonly reloadPending: (sdkSessionId: string) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** Atomically: refuse if the session has background work, else mark it. */
  reserve(key: string, sdkSessionId: string, state: BackgroundState): ReserveResult {
    if (state.activeBackgroundTasks > 0) return { ok: false, reason: "background-tasks", state };
    if (state.awaitingTaskReport) return { ok: false, reason: "awaiting-task-report", state };
    const launched = this.lastLaunchAt.get(key);
    if (launched !== undefined && this.now() - launched < BACKGROUND_LAUNCH_SETTLE_MS) {
      return { ok: false, reason: "recent-launch", state };
    }
    // One rewrite at a time per session: two back-to-back compacts race the
    // SDK's in-memory state (see the rollup runner).
    if (this.byKey.has(key)) return { ok: false, reason: "already-pending", state };
    const id = randomUUID();
    this.byKey.set(key, {
      id,
      sdkSessionId,
      phase: "rewriting",
      timer: this.expireAfter(key, id, COMPACT_RESERVATION_REWRITE_TTL_MS),
    });
    return { ok: true, reservationId: id };
  }

  /**
   * The rewrite is over (or its client went away). Keep the mark only while a
   * reload is actually pending; otherwise nothing will reload and launches
   * are safe again.
   */
  finish(key: string, reservationId: string): void {
    const r = this.byKey.get(key);
    if (!r || r.id !== reservationId) return;
    clearTimeout(r.timer);
    if (this.reloadPending(r.sdkSessionId)) {
      r.phase = "awaiting-reload";
      r.timer = this.expireAfter(key, r.id, COMPACT_RESERVATION_RELOAD_TTL_MS);
    } else {
      this.byKey.delete(key);
    }
  }

  /** The session reloaded after its compact: release whatever is held. */
  clear(key: string): void {
    const r = this.byKey.get(key);
    if (!r) return;
    clearTimeout(r.timer);
    this.byKey.delete(key);
  }

  isPending(key: string): boolean {
    return this.byKey.has(key);
  }

  /**
   * The hook's question for a tool call that would start a background task:
   * a denial reason while a compact is pending, otherwise null — and the
   * allowed launch starts the settle window `reserve` honours.
   */
  launchDenial(key: string): string | null {
    if (this.byKey.has(key)) return BACKGROUND_LAUNCH_DENIAL;
    this.lastLaunchAt.set(key, this.now());
    return null;
  }

  /** Drop every timer (daemon shutdown). */
  dispose(): void {
    for (const r of this.byKey.values()) clearTimeout(r.timer);
    this.byKey.clear();
  }

  private expireAfter(key: string, id: string, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const r = this.byKey.get(key);
      if (r?.id !== id) return;
      this.byKey.delete(key);
      log.warn({ key, phase: r.phase }, "Compact reservation expired; background launches allowed again");
    }, ms);
    timer.unref?.();
    return timer;
  }
}

/** Tools whose call starts a task that outlives the tool call. */
const ALWAYS_BACKGROUND_TOOLS: ReadonlySet<string> = new Set(["Monitor"]);

/**
 * Would this tool call start a background task? Any tool asked to run in the
 * background (Agent/Task subagents, Bash, …) plus tools that only ever run that
 * way.
 */
export function startsBackgroundTask(toolName: string, toolInput: unknown): boolean {
  if (ALWAYS_BACKGROUND_TOOLS.has(toolName)) return true;
  if (toolInput === null || typeof toolInput !== "object") return false;
  return (toolInput as { run_in_background?: unknown }).run_in_background === true;
}

/**
 * PreToolUse hook: while a compact is pending on the session, deny every call
 * that would start a background task. `denial` is read per call.
 */
export function backgroundLaunchGuardHooks(sessionKey: string | undefined, denial: () => string | null) {
  return {
    PreToolUse: [{
      // A guard: a callback that throws denies the call instead of letting
      // a launch through that the pending reload would kill.
      onFailure: "block" as const,
      hooks: [async (input: { tool_name: string; tool_input: unknown }) => {
        if (!startsBackgroundTask(input.tool_name, input.tool_input)) return {};
        const reason = denial();
        if (!reason) return {};
        log.info({ key: sessionKey, tool: input.tool_name }, "Denied a background launch while a compact is pending");
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: reason,
          },
        };
      }],
    }],
  };
}
