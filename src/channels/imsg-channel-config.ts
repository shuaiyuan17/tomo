import type { spawn as nodeSpawn } from "node:child_process";
import type { ServiceLookup } from "./imsg-satellite.js";
import type { AttachmentLookup } from "./imsg-attachment-lookup.js";
import type { HeicTargetFormat } from "./heic.js";
import type { ImsgCapabilities } from "./imsg-rpc.js";

export interface ImsgChannelConfig {
  /** Path to the imsg binary. Defaults to "imsg" (resolved via PATH). */
  cliPath?: string;
  /** Optional chat.db path forwarded as `imsg rpc --db`. */
  dbPath?: string;
  /** Base directory where inbound images are persisted. If omitted, images are not saved to disk. */
  imageStoreBaseDir?: string;
  /**
   * Base dir for the path-only any-MIME file store. Undefined means the store
   * is OFF — there is deliberately no fallback to `imageStoreBaseDir` here.
   * The "unset follows saveInboundImages" default belongs to the config parser
   * (`saveInboundFiles` in config.ts) and lives there alone; repeating it in
   * this constructor is what let `saveInboundFiles: false` keep writing files.
   */
  fileStoreBaseDir?: string;
  /** Persistent cache for inbound message GUIDs. Null/undefined keeps it in memory only. */
  dedupeStorePath?: string | null;
  /** Persistent watch cursor (last seen chat.db rowid). Null/undefined keeps it in memory only. */
  cursorStorePath?: string | null;
  /** Test seam: replacement for child_process.spawn. */
  spawnFn?: typeof nodeSpawn;
  /** Test seam: replacement for the `imsg status --json` capability probe. */
  probeCapabilities?: () => Promise<ImsgCapabilities>;
  /** Test seam: restart backoff schedule. */
  restartDelaysMs?: number[];
  /** Test seam: silent retry schedule for a degraded startup capability probe. */
  capabilityRetryDelaysMs?: number[];
  /** Test seam: rate-limit floor between on-demand capability re-probes. */
  capabilityReprobeMinIntervalMs?: number;
  /** Max time to wait for a `drain` on a parked write before treating the child
   *  as wedged and restarting it. Default 10s. */
  drainWaitTimeoutMs?: number;
  /**
   * Test seam: message-service lookup for satellite (iMessageLite) detection.
   * Defaults to a read-only chat.db-backed lookup over `dbPath` (or the
   * standard `~/Library/Messages/chat.db`).
   */
  serviceLookup?: ServiceLookup;
  /**
   * Test seam: HEIC/HEIF converter. Given a source path and a target format,
   * returns the path to a temp JPEG/PNG (the channel reads then unlinks it)
   * or `null` on failure. Defaults to a macOS `sips`-backed implementation.
   */
  convertHeic?: (srcPath: string, format: HeicTargetFormat, timeoutMs?: number) => Promise<string | null>;
  /** Override {@link MESSAGE_CONVERSION_BUDGET_MS}. Tests only. */
  conversionBudgetMs?: number;
  /** Override {@link DEFERRED_ATTACHMENT_POLL_INTERVAL_MS}. Tests only. */
  deferredAttachmentPollIntervalMs?: number;
  /** Override {@link DEFERRED_ATTACHMENT_TIMEOUT_MS}. Tests only. */
  deferredAttachmentTimeoutMs?: number;
  /** Override {@link DEFERRED_FOLLOWUP_DISPATCH_TIMEOUT_MS}. Tests only. */
  deferredFollowUpDispatchTimeoutMs?: number;
  /** Override {@link DEFERRED_CHECK_STOP_WAIT_MS}. Tests only. */
  deferredCheckStopWaitMs?: number;
  /** Override {@link MAX_DEFERRED_ATTACHMENT_WATCHES}. Tests only. */
  maxDeferredAttachmentWatches?: number;
  /**
   * Test seam: re-reads a message's attachment rows (used when a deferred
   * attachment arrived with no local path). Defaults to a read-only chat.db
   * lookup over `dbPath`.
   */
  attachmentLookup?: AttachmentLookup;
  /**
   * Test seam: alpha-channel probe for a source image file. `true`/`false` on
   * a clean probe, `null` when unknown. Defaults to `sips -g hasAlpha`.
   */
  probeHeicAlpha?: (srcPath: string, timeoutMs?: number) => Promise<boolean | null>;
}
