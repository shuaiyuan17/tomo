import { spawn } from "node:child_process";
import { log } from "../logger.js";
import {
  consumeRestartRequestFromToolResult,
  drainRestartRequests,
  restartWorkerInvocation,
  takePendingRestartRequest,
  type RestartRequest,
  type RestartRequestDiscard,
} from "../restart-request.js";
import type { ReplyContext } from "./live-session.js";

/** The part of a turn's reply context the coordinator may mark. */
type RestartInitiator = Pick<ReplyContext, "initiatedRestart">;

export interface RestartCoordinatorDeps {
  /** True once `Agent.stop()` has begun: a stop outranks any restart. */
  isStopping(): boolean;
  queuePendingErrorNote(sessionKey: string, visibleError: string): void;
  /**
   * The restart of `sessionKey`'s request is about to be launched: called
   * once, before the helper is spawned, so the session can record that the
   * restart is its own (a sub-session then waits for the owner after it,
   * instead of resuming into a loop).
   */
  onRestartClaimed?(sessionKey: string): void;
}

/**
 * Session-requested daemon restarts (`tomo restart` from a turn): claims the
 * request, launches the restart helper once, and drops duplicates.
 */
export class RestartCoordinator {
  private restartInFlight = false;

  constructor(private readonly deps: RestartCoordinatorDeps) {}

  private get stopping(): boolean {
    return this.deps.isStopping();
  }

  private queuePendingErrorNote(sessionKey: string, visibleError: string): void {
    this.deps.queuePendingErrorNote(sessionKey, visibleError);
  }

  /**
   * A session-originated `tomo restart` is acknowledged only when its Bash
   * result comes back through the SDK event stream. Starting the helper here
   * gives us an exact persistence boundary instead of racing daemon shutdown
   * against an arbitrary timer.
   *
   * ASSUMPTION, worth stating because nothing enforces it: we treat the
   * arrival of the streamed `tool_result` event as proof that the SDK child
   * has already written that result to its transcript. There is no flush
   * handshake — the event says the child produced the result, not that it
   * durably recorded it. If the child batches its JSONL writes, a restart
   * fired on this event could still race the write, which would land us back
   * in #257 with a narrower window. The end-of-turn fallback is strictly safer
   * on that axis (the turn is over, so the write has happened), and this path
   * exists because it is *sooner*. Revisit if the SDK ever exposes a flush.
   *
   * `BashOutput` is accepted alongside `Bash`: a backgrounded
   * `tomo restart &`-style invocation returns its marker through the
   * background-output tool, not the original call.
   *
   * `turn` is the reply context of the running turn whose own Bash call
   * produced this result (LiveSession attributes it; anything it cannot tie to
   * the turn arrives without one). When this result launches the restart and
   * the helper has actually started, that turn is flagged as the initiator
   * (ReplyContext.initiatedRestart), so the note after the restart says the
   * turn restarted Tomo itself. Nothing else changes for it: the turn is
   * still interrupted. Without a turn, nothing is flagged.
   */
  handleToolResult(
    sessionKey: string,
    toolName: string,
    content: unknown,
    isError: boolean,
    turn?: RestartInitiator,
  ): void {
    if ((toolName !== "Bash" && toolName !== "BashOutput") || isError) return;
    if (this.stopping) {
      // Same rule as handleTurnComplete: a stop in progress outranks a restart.
      this.drainRestartRequests(sessionKey, "shutting-down");
      return;
    }
    const request = consumeRestartRequestFromToolResult(
      content,
      sessionKey,
      undefined,
      undefined,
      (discarded) => this.logRestartRequestDiscard(sessionKey, discarded),
    );
    if (!request) return;

    if (this.restartInFlight) {
      // DRAIN, don't just return. This marker's own file is already consumed,
      // but a second `tomo restart` in the same turn leaves a second file, and
      // returning here left it on disk: the restart completes, and within the
      // TTL the next turn's fallback claims the straggler and restarts AGAIN,
      // announcing the older reason.
      const alsoDropped = this.drainRestartRequests(sessionKey, "superseded");
      this.queuePendingErrorNote(
        sessionKey,
        alsoDropped > 0
          ? `A Tomo restart was already in progress; ${alsoDropped + 1} duplicate restart requests were ignored.`
          : "A Tomo restart was already in progress; the duplicate restart request was ignored.",
      );
      return;
    }
    this.restartInFlight = true;
    this.launchAcknowledgedRestart(request, turn);
  }

  /**
   * Throw away restart requests this daemon will not honour, and say so.
   *
   * `superseded`: a restart is not a queue — once one is in flight, every
   * other request for that session is answered by it, and leaving a file
   * behind means the daemon comes back up and restarts a second time off a
   * request nobody is waiting on. `shutting-down`: a restart would resurrect a
   * daemon that was deliberately stopped. Returns how many were dropped; every
   * one is reported through the discard log, including the one that would
   * otherwise have been acted on.
   */
  private drainRestartRequests(sessionKey: string, reason: "superseded" | "shutting-down"): number {
    return drainRestartRequests(
      sessionKey,
      reason,
      undefined,
      (discarded) => this.logRestartRequestDiscard(sessionKey, discarded),
    );
  }

  private logRestartRequestDiscard(sessionKey: string, discarded: RestartRequestDiscard): void {
    log.warn(
      {
        sessionKey,
        reason: discarded.reason,
        ...("request" in discarded ? { requestId: discarded.request.id, requestedAt: discarded.request.requestedAt } : {}),
      },
      "Discarded a restart request without restarting",
    );
  }

  /**
   * Fallback for a restart whose marker never came back.
   *
   * The handshake in `handleToolResult` needs the marker line to survive into
   * the Bash tool result, and the model writes the command: `tomo restart
   * >/dev/null`, a redirect into a log, or `... | tail -1` all discard it. The
   * CLI has already told the owner a restart is coming, so the turn ending is
   * the backstop — later than the acknowledgement boundary #257 wants, but
   * still after the SDK recorded the tool result, and infinitely better than
   * silently doing nothing. A request claimed here is one that mid-turn
   * acknowledgement missed, so log it: a rising rate means the model has
   * settled on a redirecting invocation and the happy path has gone dark.
   */
  handleTurnComplete(sessionKey: string): void {
    if (this.stopping) {
      // `tomo stop` MUST NOT be undone by a restart. The completion signal
      // fires on shutdown exits too (that is the point of the `finally`), so
      // without this a session that had just asked for a restart would have
      // its request claimed here and spawn a helper that brings the daemon
      // straight back up — the user's stop silently reversed.
      this.drainRestartRequests(sessionKey, "shutting-down");
      return;
    }
    if (this.restartInFlight) {
      // Same reason as the marker path: claim and drop rather than leave the
      // file for the post-restart daemon to act on.
      this.drainRestartRequests(sessionKey, "superseded");
      return;
    }
    const request = takePendingRestartRequest(
      sessionKey,
      undefined,
      (discarded) => this.logRestartRequestDiscard(sessionKey, discarded),
    );
    if (!request) return;
    log.warn(
      { sessionKey, requestId: request.id },
      "Restart request never appeared in a Bash result; restarting at end of turn",
    );
    this.restartInFlight = true;
    this.launchAcknowledgedRestart(request);
  }

  private launchAcknowledgedRestart(request: RestartRequest, initiator?: RestartInitiator): void {
    if (request.sessionKey) {
      try {
        this.deps.onRestartClaimed?.(request.sessionKey);
      } catch (err) {
        log.warn({ err, sessionKey: request.sessionKey }, "Restart claim hook failed");
      }
    }
    const cliPath = process.argv[1];
    if (!cliPath) {
      this.reportScheduledRestartFailure(request.sessionKey, "CLI entry point is unavailable");
      return;
    }

    const worker = restartWorkerInvocation(request, cliPath);
    const child = spawn(worker.command, worker.args, {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: worker.env,
    });
    let stderr = "";
    let failureReported = false;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2_000);
    });
    const reportFailure = (detail: string) => {
      if (failureReported) return;
      failureReported = true;
      // A restart that did not happen was not caused by this turn.
      if (initiator) delete initiator.initiatedRestart;
      this.reportScheduledRestartFailure(request.sessionKey, detail);
    };
    // Only a helper that actually started can be the cause of the shutdown.
    child.once("spawn", () => {
      if (initiator && !failureReported) initiator.initiatedRestart = request.reason ? { reason: request.reason } : {};
    });
    child.once("error", (err) => reportFailure(err.message));
    child.once("exit", (code, signal) => {
      if (code === 0) return;
      const detail = stderr.trim() || `restart helper exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`;
      reportFailure(detail);
    });
    child.unref();
  }

  private reportScheduledRestartFailure(sessionKey: string, detail: string): void {
    this.restartInFlight = false;
    const message = `Scheduled Tomo restart failed: ${detail}`;
    log.error({ sessionKey, detail }, "Scheduled restart failed");
    this.queuePendingErrorNote(sessionKey, message);
  }
}
