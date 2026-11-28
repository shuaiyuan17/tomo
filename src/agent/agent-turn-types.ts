import type { Channel, IncomingMessage } from "../channels/types.js";
import type { ReplyTarget } from "../sessions/types.js";
import type { InboundItem } from "./inbound-batcher.js";
import type { OwnerNoticeTarget, ShutdownTurnEnd } from "./turn-runner.js";
import type { UsageSource } from "../usage/ledger.js";
import type { OwnerTurnMessage, TurnOrigin } from "./audience.js";

// Request and option shapes passed between the Agent's turn entry points.

export interface UserTurnRequest {
  webRequestId?: string;
  key: string;
  promptText: string;
  sourceChannelName: string;
  /** The sender's IANA time zone for this turn's stamp, when one applies —
   *  see Agent.senderTimeZone. Undefined for a batch whose senders disagree. */
  senderTimeZone?: string;
  replyChannel: Channel;
  replyChatId: string;
  replyToMessageId?: string;
  images?: IncomingMessage["images"];
  documents?: IncomingMessage["documents"];
  suppressErrors: boolean;
  errorLogMessage: string;
  /** Steer this turn into the session's in-flight turn (config `steering`)
   *  instead of running through the per-session queue. */
  steer?: boolean;
  /** Where this turn's message(s) must be ANSWERED if the turn they steer into
   *  is silent: the summoned GROUP key for a group message running on a dm:
   *  session, the session's own key otherwise. Same derivation as
   *  summonReminder, and one entry PER MESSAGE in the batch's numbering order
   *  — a coalesced batch can mix the owner's DM with one or more summoned
   *  groups, and the note pairs targets with those ordinals. */
  steerAudience: string[];
  /** True for turns where most inputs are expected to resolve to NO_REPLY. */
  passiveListen?: boolean;
  /** Durable-inbox progress for the messages behind this turn. */
  inboxHooks?: InboxTurnHooks;
  /**
   * The owner's own messages in a batch that also holds a group's. When the
   * turn is refused for the shared prompt, these are queued again as their
   * own turn (which needs no reload), not dropped with the group's.
   */
  ownerItems?: InboundItem[];
  /** The owner's own messages in this turn (their private DM ones), for
   *  task_message to attach. See TurnAudienceRegistry.ownerMessages. */
  ownerMessages?: OwnerTurnMessage[];
  /** Owner DM notice for an error `suppressErrors` keeps out of the chat. */
  ownerNotice?: OwnerNoticeTarget;
  /** This turn's inbound audiences, in order (see agent/audience.ts): "dm",
   *  or a raw group key for a summoned group's messages. Session-scoped MCP
   *  tools resolve against these, not against the session key. */
  audiences?: string[];
  /** The chat each of this turn's messages came in on, in order. Credential
   *  requests are asked there (`TurnAudienceRegistry.turnOrigin`). */
  origins?: TurnOrigin[];
}

export interface CronTurnOptions {
  /** False for silent housekeeping turns such as LCM rollups. */
  showTyping?: boolean;
  /**
   * Asked when the turn is about to run (after it waited its place in the
   * queue): true drops it, and the call resolves false. For a prompt built
   * for a state that may have changed while it waited: a rollup nudge with
   * private memory lines in it, and a group summoned into the session since.
   */
  dropIf?: () => boolean;
  /** This turn restates a reply that was dropped as a thinking block; it
   *  must not request another restate whatever it ends on. */
  restate?: boolean;
  /** Never deliver this turn's model output to the chat. The turn still runs
   *  so housekeeping tools can complete; failures remain in logs/pending
   *  operational context. */
  suppressDelivery?: boolean;
  /** Deliver to this exact channel/chat instead of resolving from the
   *  session's reply target. Set when the caller named a specific chat
   *  (delegate sends to a raw channel:chatId target canonicalized to a dm
   *  session key). */
  deliveryTarget?: ReplyTarget;
  /** When this turn is handed to an active summoned dm session, resolve only
   *  once that turn has actually run, instead of once it has been queued.
   *  Callers that record a completion (CronScheduler.markRun advances or
   *  deletes the job) must set this, or they record success before any work
   *  happens. Off by default because the delegate path calls this from inside
   *  a session turn that the handoff target may be waiting on — see
   *  processCronMessage. */
  waitForHandoff?: boolean;
  /** Graceful shutdown ended the turn without a real outcome (see
   *  TurnSpec.onShutdown). Carried through every handoff. */
  onShutdown?: (kind: ShutdownTurnEnd) => void;
  /** The turn ended with no reply text and not by the model's choice (see
   *  TurnSpec.onEmpty). Carried through every handoff. */
  onEmpty?: () => void;
  /** The owner stopped the turn before it finished (see TurnSpec.onStopped).
   *  Carried through every handoff. */
  onStopped?: () => void;
  /** The cron job's name, for the owner notice when its failure is kept out
   *  of a group (see agent/owner-error-notice.ts), and for the usage ledger. */
  jobName?: string;
  /** The cron job's id, for the usage ledger. Set only by the scheduler. */
  jobId?: string;
  /** Usage-ledger source for a turn with no `jobId` (default "system"). */
  usageSource?: UsageSource;
  /** The audience this turn carries from the session that ASKED for it —
   *  `send_message(mode: "delegate")`, or a group's background turn handed to
   *  the summoning dm: session. Registered in the TurnAudienceRegistry for the
   *  turn's duration, so its session-scoped MCP tools resolve against the
   *  origin rather than the session key it happens to run on. Left undefined
   *  for harness-originated turns (the cron scheduler, LCM nudges), which the
   *  owner owns outright. */
  audiences?: string[];
  /** Called with the turn's registered id when it begins (only when `audiences`
   *  registers it). A permission answer binds its Allow once to that id. */
  onTurnBegin?: (turnId: number) => void;
}

export interface QueuedInboundWork {
  sessionKey: string;
  items: InboundItem[];
  steer: boolean;
}

/** What a /rewind did — see ChatCommandDeps.rewindSession. */
export type RewindOutcome = {
  count: number;
  preview: string;
  stoppedTurn: boolean;
  droppedMessages: number;
  /** A stuck first turn was stopped; there was no earlier history to fork. */
  nothingToRewind?: boolean;
};

/**
 * How a user turn reports progress to the durable inbox. `notConsumed`: the
 * messages are being held back (a turn was set up, or /restore deferred
 * them) and are NOT consumed unless `onPromptHandedOff` follows (the SDK took
 * the prompt, see MessageRequest.onPromptHandedOff). Neither called: the
 * messages were deliberately dropped (allowlist, unmentioned group), which
 * is a consumption.
 */
export interface InboxTurnHooks {
  notConsumed(): void;
  /**
   * Graceful shutdown stopped the turn mid-flight (TurnSpec.onShutdown
   * "interrupted"). `selfRestart`: the shutdown is the `tomo restart` this
   * turn ran itself.
   */
  cutShort(selfRestart?: { reason?: string }): void;
  onPromptHandedOff(): void;
  /**
   * The turn was refused on purpose before its prompt reached the model, and
   * its senders were told (a group's turn with no shared-prompt session in
   * time). A deliberate drop: the messages must not come back after a restart.
   * `requeuedIds`: records of this turn that were put back in the queue
   * instead (the owner's own messages in a mixed batch); they stay open.
   */
  refused(requeuedIds?: string[]): void;
}
