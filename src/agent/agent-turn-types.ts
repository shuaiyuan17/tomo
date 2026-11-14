import type { Channel, IncomingMessage } from "../channels/types.js";
import type { ReplyTarget } from "../sessions/types.js";
import type { InboundItem } from "./inbound-batcher.js";
import type { OwnerNoticeTarget, ShutdownTurnEnd } from "./turn-runner.js";

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
  /** Owner DM notice for an error `suppressErrors` keeps out of the chat. */
  ownerNotice?: OwnerNoticeTarget;
  /** This turn's inbound audiences, in order (see agent/audience.ts): "dm",
   *  or a raw group key for a summoned group's messages. Session-scoped MCP
   *  tools resolve against these, not against the session key. */
  audiences?: string[];
}

export interface CronTurnOptions {
  /** False for silent housekeeping turns such as LCM rollups. */
  showTyping?: boolean;
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
  /** The cron job's name, for the owner notice when its failure is kept out
   *  of a group (see agent/owner-error-notice.ts). */
  jobName?: string;
  /** The audience this turn carries from the session that ASKED for it —
   *  `send_message(mode: "delegate")`, or a group's background turn handed to
   *  the summoning dm: session. Registered in the TurnAudienceRegistry for the
   *  turn's duration, so its session-scoped MCP tools resolve against the
   *  origin rather than the session key it happens to run on. Left undefined
   *  for harness-originated turns (the cron scheduler, LCM nudges), which the
   *  owner owns outright. */
  audiences?: string[];
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
