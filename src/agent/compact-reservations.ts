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
 * PreToolUse hook (`launchDenial`).
 *
 * The mark's lifetime is tied to the thing it protects, the pending reload,
 * not to a clock or a connection:
 *
 * 1. `rewriting` — approved, the rewrite may be running. Left only by an
 *    explicit `finish` from the rewriter, or by a long safety timeout for a
 *    rewriter that died without saying so. Neither releases while a compact
 *    trigger is on disk: then the phase becomes `awaiting-reload` instead.
 *    A dropped connection means nothing here — the CLI may still be writing.
 * 2. `awaiting-reload` — the trigger is on disk. Held, with no timeout, for as
 *    long as the trigger exists for the session's current SDK session id.
 * 3. `reloading` — the turn-end path consumed the trigger and is about to
 *    close the session (possibly after a steered turn). Held until `clear`.
 *
 * The opposite race is covered too: a launch the hook allowed (or a task the
 * owner is moving to the background) can take a moment to show up in the
 * SDK's background set, so `reserve` also refuses while a move is in flight
 * and for a short settle window after any allowed launch.
 */

/**
 * A `rewriting` reservation whose rewriter never reports back is resolved
 * after this: held on if a trigger appeared, released if none did. Long, so a
 * slow rewrite of a big session is never cut short.
 */
export const COMPACT_RESERVATION_REWRITE_SAFETY_MS = 30 * 60 * 1000;
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
  /** Foreground tasks being moved to the background right now (web action). */
  backgroundingInFlight: number;
}

export type ReserveResult =
  | { ok: true; reservationId: string }
  | {
    ok: false;
    reason: "background-tasks" | "awaiting-task-report" | "backgrounding" | "recent-launch" | "already-pending";
    state: BackgroundState;
  };

type Phase = "rewriting" | "awaiting-reload" | "reloading";

interface Reservation {
  id: string;
  sdkSessionId: string | null;
  phase: Phase;
  timer: ReturnType<typeof setTimeout> | null;
}

export class CompactReservations {
  private byKey = new Map<string, Reservation>();
  private lastLaunchAt = new Map<string, number>();

  constructor(
    /**
     * Is a reload still pending for this key's SDK session: a compact trigger
     * on disk for it, and it is still the key's current SDK session?
     */
    private readonly reloadPending: (key: string, sdkSessionId: string) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** Atomically: refuse if the session has background work, else mark it. */
  reserve(key: string, sdkSessionId: string, state: BackgroundState): ReserveResult {
    if (state.activeBackgroundTasks > 0) return { ok: false, reason: "background-tasks", state };
    if (state.awaitingTaskReport) return { ok: false, reason: "awaiting-task-report", state };
    if (state.backgroundingInFlight > 0) return { ok: false, reason: "backgrounding", state };
    const launched = this.lastLaunchAt.get(key);
    if (launched !== undefined && this.now() - launched < BACKGROUND_LAUNCH_SETTLE_MS) {
      return { ok: false, reason: "recent-launch", state };
    }
    // One rewrite at a time per session: two back-to-back compacts race the
    // SDK's in-memory state (see the rollup runner).
    if (this.current(key)) return { ok: false, reason: "already-pending", state };
    const id = randomUUID();
    const reservation: Reservation = { id, sdkSessionId, phase: "rewriting", timer: null };
    reservation.timer = setTimeout(() => {
      reservation.timer = null;
      if (this.byKey.get(key) !== reservation || reservation.phase !== "rewriting") return;
      log.warn({ key }, "Compact rewriter never reported back; resolving its reservation");
      this.settleRewrite(key, reservation);
    }, COMPACT_RESERVATION_REWRITE_SAFETY_MS);
    reservation.timer.unref?.();
    this.byKey.set(key, reservation);
    return { ok: true, reservationId: id };
  }

  /**
   * The rewriter is done (succeeded, failed, or never started). With a
   * trigger on disk the mark is held until the reload; without one nothing
   * will reload and launches are safe again.
   */
  finish(key: string, reservationId: string): void {
    const r = this.byKey.get(key);
    if (!r || r.id !== reservationId || r.phase !== "rewriting") return;
    this.settleRewrite(key, r);
  }

  /**
   * The turn-end path consumed this key's trigger and will close the session
   * (now, or after a steered turn). Hold the mark — creating one if the
   * rewrite bypassed the gate — until `clear`.
   */
  holdForReload(key: string): void {
    const r = this.byKey.get(key);
    if (r) {
      if (r.timer) clearTimeout(r.timer);
      r.timer = null;
      r.phase = "reloading";
      return;
    }
    this.byKey.set(key, { id: randomUUID(), sdkSessionId: null, phase: "reloading", timer: null });
  }

  /** The session reloaded after its compact: release whatever is held. */
  clear(key: string): void {
    const r = this.byKey.get(key);
    if (!r) return;
    if (r.timer) clearTimeout(r.timer);
    this.byKey.delete(key);
  }

  isPending(key: string): boolean {
    return this.current(key) !== undefined;
  }

  /**
   * The hook's question for a tool call that would start a background task:
   * a denial reason while a compact is pending, otherwise null — and the
   * allowed launch starts the settle window `reserve` honours.
   */
  launchDenial(key: string): string | null {
    if (this.current(key)) return BACKGROUND_LAUNCH_DENIAL;
    this.noteLaunch(key);
    return null;
  }

  /** A background task was just started some other way (web "move to background"). */
  noteLaunch(key: string): void {
    this.lastLaunchAt.set(key, this.now());
  }

  /** Drop every timer (daemon shutdown). */
  dispose(): void {
    for (const r of this.byKey.values()) if (r.timer) clearTimeout(r.timer);
    this.byKey.clear();
  }

  private settleRewrite(key: string, r: Reservation): void {
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    if (r.sdkSessionId && this.reloadPending(key, r.sdkSessionId)) {
      r.phase = "awaiting-reload";
    } else {
      this.byKey.delete(key);
    }
  }

  /**
   * The key's live reservation. An `awaiting-reload` one lasts exactly as
   * long as its trigger: once the trigger is gone (consumed by a reload) or
   * the key has moved to another SDK session, no reload is pending any more.
   */
  private current(key: string): Reservation | undefined {
    const r = this.byKey.get(key);
    if (r?.phase === "awaiting-reload" && !(r.sdkSessionId && this.reloadPending(key, r.sdkSessionId))) {
      this.byKey.delete(key);
      return undefined;
    }
    return r;
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
