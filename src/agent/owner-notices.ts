import type { Channel } from "../channels/types.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { isOwnerHandle } from "../owner.js";
import type { OwnerRouter } from "../router.js";
import type { SessionStore } from "../sessions/index.js";
import {
  dmIdentityFromSessionKey,
  dmSessionKeyForIdentity,
  isDmSessionKey,
  isGroupSessionKey,
  privateReplyTargetFromSessionKey,
} from "../sessions/keys.js";
import type { ReplyTarget } from "../sessions/types.js";
import type { OwnerErrorNotifier } from "./owner-error-notice.js";
import type { OwnerNoticeTarget } from "./turn-runner.js";

export interface OwnerNoticesDeps {
  sessions: SessionStore;
  router: OwnerRouter;
  getChannel(name: string): Channel | undefined;
  isStopping(): boolean;
  /** End time of each session's last successful turn (owned by the Agent). */
  lastGoodTurnAt: Map<string, number>;
  ownerErrorNotifier: OwnerErrorNotifier;
}

/**
 * Notices to the owner that need no model call: suppressed-error reports,
 * `notifyOwner` and `sendNotification`.
 */
export class OwnerNotices {
  private readonly sessions: SessionStore;
  private readonly router: OwnerRouter;
  private readonly lastGoodTurnAt: Map<string, number>;
  private readonly ownerErrorNotifier: OwnerErrorNotifier;

  constructor(private readonly deps: OwnerNoticesDeps) {
    this.sessions = deps.sessions;
    this.router = deps.router;
    this.lastGoodTurnAt = deps.lastGoodTurnAt;
    this.ownerErrorNotifier = deps.ownerErrorNotifier;
  }

  private get stopping(): boolean {
    return this.deps.isStopping();
  }

  private getChannel(name: string): Channel | undefined {
    return this.deps.getChannel(name);
  }

  /**
   * Owner-notice target for a failure kept out of a chat (see
   * agent/owner-error-notice.ts). `groupKey` names the group a summoned turn
   * belongs to when it runs on the owner's dm: session.
   *
   * - a group: reported to the owner's DM (resolveOwnerNoticeTarget), never
   *   the group — or, for a summoned group, to the dm: session it ran on;
   * - an identity's dm: session: reported IN that DM — the error was held
   *   back there, so this is the only visible trace of it;
   * - a raw private chat (not an identity): reported to the owner, not to
   *   whoever that chat belongs to.
   *
   * Callers attach a target only where the turn's policy suppresses errors;
   * an error delivered visibly is never reported again.
   */
  ownerNoticeTarget(sessionKey: string, turnKind: string, groupKey?: string): OwnerNoticeTarget {
    const noticeKey = groupKey !== undefined && isGroupSessionKey(groupKey) ? groupKey : sessionKey;
    // The turn ran on an identity's dm: session (its own turn, or a summoned
    // group's): the notice goes to THAT identity's DM, where /rewind works.
    const ranOnDm = isDmSessionKey(sessionKey);
    const deliver = ranOnDm ? { rewindable: true, deliverTo: sessionKey } : {};
    if (isGroupSessionKey(noticeKey)) {
      const title = this.sessions.getEntry(noticeKey)?.chatTitle;
      return {
        noticeKey,
        label: title ? `group "${title}" (${noticeKey})` : `group ${noticeKey}`,
        turnKind,
        ...deliver,
      };
    }
    if (ranOnDm) return { noticeKey, label: `this DM session (${noticeKey})`, turnKind, ...deliver };
    return { noticeKey, label: `private chat ${noticeKey}`, turnKind };
  }

  /**
   * Where an owner notice goes — resolved STRICTLY through the configured
   * owner, never through a raw session key. A notice carries a group's
   * title, key, error text and session id; `sendNotification`'s fallback to
   * "the first private chat with a session" could hand that to whoever else
   * has messaged Tomo privately.
   *
   * `deliverTo` (a dm: session the turn ran on) must be the owner's session;
   * any other dm: key (a former identity's) gets no notice.
   *
   * Undefined when there is no owner or no owner DM on a loaded channel.
   */
  private resolveOwnerNoticeTarget(deliverTo: string | undefined): { channel: Channel; chatId: string } | undefined {
    const owner = config.owner;
    const ownerKey = this.router.ownerSessionKey();
    if (!owner || !ownerKey) return undefined;
    if (deliverTo !== undefined && dmSessionKeyForIdentity(dmIdentityFromSessionKey(deliverTo) ?? "") !== ownerKey) return undefined;
    // The persisted last-active target is used only while it is still one of
    // the owner's CURRENT private handles — a rebinding, or a group id, must
    // not carry a notice somewhere else.
    const isPrivateBinding = (t: ReplyTarget | undefined): t is ReplyTarget => t !== undefined
      && isOwnerHandle(owner, t.channelName, t.chatId);
    const persisted = this.router.getReplyTarget(ownerKey);
    const configured = this.router.deriveReplyTargetFromConfig(owner.name);
    const target = isPrivateBinding(persisted) ? persisted : isPrivateBinding(configured) ? configured : undefined;
    if (!target) return undefined;
    const channel = this.getChannel(target.channelName);
    return channel ? { channel, chatId: target.chatId } : undefined;
  }

  /** Deliver an owner notice; false (nothing sent) when no owner target. */
  async sendOwnerNotice(text: string, deliverTo: string | undefined): Promise<boolean> {
    const target = this.resolveOwnerNoticeTarget(deliverTo);
    if (!target) {
      log.warn({ deliverTo }, "Owner error notice dropped: no configured owner identity with a reachable DM");
      return false;
    }
    await target.channel.send({ chatId: target.chatId, text });
    return true;
  }

  /** Fire-and-forget owner DM for a suppressed error; never throws. */
  reportSuppressedError(sessionKey: string, target: OwnerNoticeTarget, detail: string): void {
    // A turn torn down by shutdown is not a failure worth a DM.
    if (this.stopping) return;
    const sdkSessionId = this.sessions.getSdkSessionId(sessionKey);
    const lastGoodTurnAt = this.lastGoodTurnAt.get(sessionKey);
    void this.ownerErrorNotifier.report({
      ...target,
      detail,
      ...(sdkSessionId ? { sdkSessionId } : {}),
      ...(lastGoodTurnAt !== undefined ? { lastGoodTurnAt } : {}),
    });
  }

  /**
   * DM the configured OWNER (no agent query). Unlike sendNotification it never
   * falls back to some other private chat, so it is safe for content that is
   * the owner's business only. Resolves false when nothing was sent (no
   * owner, or no reachable owner DM).
   */
  async notifyOwner(text: string): Promise<boolean> {
    return this.sendOwnerNotice(text, undefined);
  }

  /** Send a direct notification to the user's DM channel (no agent query) */
  async sendNotification(text: string): Promise<void> {
    const dmKey = this.router.ownerSessionKey();
    let target: ReplyTarget | undefined;

    if (dmKey) {
      const identityName = dmIdentityFromSessionKey(dmKey);
      target = this.router.getReplyTarget(dmKey)
        ?? (identityName !== undefined ? this.router.deriveReplyTargetFromConfig(identityName) : undefined)
        ?? privateReplyTargetFromSessionKey(dmKey);
    }

    if (!target && !config.owner) {
      // No owner at all — find the first DM (non-group) session across all
      // channels. With an owner, a notification never goes to anyone else.
      for (const [key] of this.sessions.listSdkSessionIds()) {
        const parsed = privateReplyTargetFromSessionKey(key);
        if (parsed) { target = parsed; break; }
      }
    }

    if (!target) { log.debug("Notification: no active DM session"); return; }

    const channel = this.getChannel(target.channelName);
    if (!channel) return;

    await channel.send({ chatId: target.chatId, text });
  }
}
