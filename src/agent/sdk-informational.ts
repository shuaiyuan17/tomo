import type { SDKInformationalMessage } from "@anthropic-ai/claude-agent-sdk";
import { ownerT, type OwnerText } from "../i18n/index.js";
import { log } from "../logger.js";
import { shortErrorMessage } from "../error-text.js";
import { clip } from "../watch/protocol.js";

/** At most one owner notice per tag and session in this window. */
export const INFORMATIONAL_NOTICE_INTERVAL_MS = 60 * 60 * 1000;
/** How much of the SDK's line goes into a log entry or an owner notice. */
const INFORMATIONAL_TEXT_LIMIT = 500;

/**
 * Tags worth an owner notice: a hook callback that failed (its guard may not
 * have run) and settings Tomo passed that did not take effect. Every other
 * informational line is logged only.
 */
const OWNER_NOTICE_TAGS = new Set(["hook_callback_failed", "settings_not_in_effect"]);

/**
 * Log one `system/informational` line from the SDK: warnings as warn,
 * everything else (info, notice, suggestion) as info.
 */
export function logInformational(message: SDKInformationalMessage, sessionKey: string | undefined): void {
  const fields = {
    session: sessionKey,
    tag: message.tag ?? null,
    level: message.level,
    text: clip(message.content, INFORMATIONAL_TEXT_LIMIT),
  };
  if (message.level === "warning") log.warn(fields, "SDK informational warning");
  else log.info(fields, "SDK informational");
}

export interface InformationalNoticesDeps {
  /** The owner-notice path (Agent.notifyOwner): true once delivered. */
  notifyOwner(text: OwnerText): Promise<boolean>;
  now?: () => number;
  intervalMs?: number;
}

/**
 * Owner notices for the informational tags in OWNER_NOTICE_TAGS, at most one
 * per tag and session per interval. The slot is taken when a notice is
 * attempted, so a burst sends one notice. It is given back only when the
 * notice was definitely not sent (notifyOwner resolved false: no owner or no
 * reachable owner DM). A rejected send keeps it: a timeout or channel error
 * may still have reached the owner, and a duplicate is worse than a gap.
 * In memory: a restart can repeat a notice.
 */
export class InformationalNotices {
  private readonly lastNoticeAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(private readonly deps: InformationalNoticesDeps) {
    this.now = deps.now ?? Date.now;
    this.intervalMs = deps.intervalMs ?? INFORMATIONAL_NOTICE_INTERVAL_MS;
  }

  observe(sessionKey: string, message: SDKInformationalMessage): void {
    const tag = message.tag;
    if (tag === undefined || !OWNER_NOTICE_TAGS.has(tag)) return;
    const slot = `${tag}\u0000${sessionKey}`;
    const now = this.now();
    const last = this.lastNoticeAt.get(slot);
    if (last !== undefined && now - last < this.intervalMs) return;
    this.lastNoticeAt.set(slot, now);
    const t = ownerT("notices");
    const params = { session: sessionKey, text: clip(message.content, INFORMATIONAL_TEXT_LIMIT) };
    const text = tag === "hook_callback_failed"
      ? t("sdkInformational.hookCallbackFailed", params)
      : t("sdkInformational.settingsNotInEffect", params);
    const release = () => { if (this.lastNoticeAt.get(slot) === now) this.lastNoticeAt.delete(slot); };
    void Promise.resolve().then(() => this.deps.notifyOwner(text)).then((delivered) => {
      if (delivered) log.warn({ session: sessionKey, tag }, "Owner told about an SDK informational warning");
      else release();
    }, (err: unknown) => {
      log.warn({ session: sessionKey, tag, error: shortErrorMessage(err) }, "Could not send the SDK informational notice");
    });
  }
}
