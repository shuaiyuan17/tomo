import { randomInt, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import type { Channel, IncomingMessage } from "../channels/types.js";
import { log } from "../logger.js";
import { expandTilde } from "../agent/bash-write-targets.js";
import { resolvedDenyDir } from "../agent/bash-sandbox.js";
import type { GroupSandboxConfig, GroupSandboxEntry } from "../agent/group-fs-policy.js";
import { scrubKnownSecrets } from "../credentials/redactor.js";

/**
 * `request_permission`: a sandboxed group turn asks the owner for one more
 * path, and the owner answers Allow once / Always allow / Deny.
 *
 * ASYNCHRONOUS, like the credential broker: the tool returns `pending` at
 * once, the owner answers later (the web card, or a DM reply carrying the
 * request's code), and the session is told how it ended with a
 * `<tomo-event type="permission">` turn. Nothing waits on the owner.
 *
 * WHERE THE ANSWER CAN COME FROM. Only the owner: the web card (owner-only
 * UI), or the owner's own private chat, where a reply counts only when it
 * names the request's code (`1 K7Q`) or quotes the request message. A bare
 * `1` does not count, and nothing said in a group ever reaches the parser
 * ({@link PermissionBroker.handleInbound} returns before looking at a group
 * message).
 *
 * WHAT A GRANT IS.
 * - Allow once: in memory only, tied to turn ids (see {@link OnceGrant}).
 * - Always allow: written to the group's `extraRead` / `extraWrite` in
 *   config.json, through the config writer (lock, backup, atomic write), and
 *   into the live config, so the next Bash or file-tool call sees it. Revoked
 *   with {@link PermissionBroker.revoke}.
 * - Deny, and a request nobody answered in time: nothing.
 *
 * One open request per group. Pending requests live in memory: a restart
 * drops them (the owner's later reply is told it is no longer open), and the
 * ledger keeps the record.
 */

export type PermissionAccess = "read" | "write";
export type PermissionDecision = "once" | "always" | "deny";
export type PermissionOutcome = "allowed_once" | "allowed_always" | "denied" | "timed_out";
export type DecisionChannel = "web" | "imessage" | "telegram";

export const PERMISSION_REQUEST_TIMEOUT_MS = 5 * 60_000;
export const MAX_REASON_LENGTH = 300;
/** How recent a sandboxed call must be to be shown as the request's trigger. */
const TRIGGER_WINDOW_MS = 10 * 60_000;
const MAX_TRIGGER_LENGTH = 2000;
/** Closed codes remembered, so a late reply is told rather than passed on. */
const MAX_CLOSED = 64;
/** Where an owner's DM reply is read. The web UI answers through its card. */
const CHAT_CHANNELS: readonly string[] = ["imessage", "telegram"];
/** Unambiguous letters and digits: no I/O/0/1, so a code reads back right. */
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_DIGITS = "23456789";
/** letter, digit, letter: an English word ("1 cat") can never be a code. */
const CODE_RE = "[A-HJ-NP-Z][2-9][A-HJ-NP-Z]";
const CODED_REPLY = [
  new RegExp(`^([123])\\s*[-:.]?\\s*(${CODE_RE})$`, "i"),
  new RegExp(`^(${CODE_RE})\\s*[-:.]?\\s*([123])$`, "i"),
];

/** What the owner is shown about a request: the web card and the DM. */
export interface PermissionRequestView {
  id: string;
  code: string;
  /** The group's title, or its key when it has none. */
  group: string;
  /** The path as the harness resolved it (the real path), not as written. */
  path: string;
  access: PermissionAccess;
  /** Written by the agent: shown as its own account, never as fact. */
  reason: string;
  /** The last sandboxed call of the turn, when there is a recent one. */
  command?: string;
  expiresAt: number;
}

interface PendingRequest extends PermissionRequestView {
  groupKey: string;
  sessionKey: string;
  /** Where the DM went, so a quoted reply can be matched to it. */
  dm?: { channel: string; chatId: string };
}

/**
 * An Allow once. Valid while a turn that was live on the requesting session
 * when the owner answered is still live, and during the first turn begun on
 * that session after the answer (normally the turn that delivers it: the
 * requesting turn has usually ended by then, and a grant it alone could use
 * would be gone before the agent could retry). Turn ids are global and never
 * reused, so a grant cannot outlive its turns. If no such turn begins within
 * the request timeout, the grant is dropped.
 */
interface OnceGrant {
  sessionKey: string;
  groupKey: string;
  path: string;
  access: PermissionAccess;
  turns: Set<number>;
  after: number;
  next: number | null;
  bindBy: number;
}

export interface PermissionRequestInput {
  /** The session the tool was called on (where the answer is delivered). */
  sessionKey: string;
  /** The group the turn is scoped to (equal to `sessionKey` for a group session). */
  groupKey: string;
  path: string;
  access: PermissionAccess;
  reason: string;
}

export type PermissionRequestResult =
  | { status: "pending"; id: string; code: string; path: string; expiresAt: number; note?: string }
  | { status: "already_allowed"; path: string }
  | { status: "denied"; reason: string; path?: string };

export type DecideResult =
  | { ok: true; outcome: Exclude<PermissionOutcome, "timed_out"> }
  | { ok: false; status: 409 | 410 | 503; code: string };

/** Judges a resolved path for a group: already reachable, never grantable, or askable. */
export type PermissionAssessment = { verdict: "allowed" } | { verdict: "never"; reason: string } | { verdict: "ask" };

export interface PermissionBrokerDeps {
  ledger: PermissionLedger;
  workspaceDir: string;
  assess(groupKey: string, sessionKey: string, path: string, access: PermissionAccess): PermissionAssessment;
  /** The owner's private chat, or undefined when there is none to reach. */
  ownerDm(): { channel: Channel; chatId: string } | undefined;
  /** The web card, when the web UI is up. */
  card(): { publish(requests: PermissionRequestView[]): void } | undefined;
  isOwnerSender(channelName: string, senderId: string | undefined): boolean;
  /** Always allow: write the grant to config (file and live). False when it could not be written. */
  persistAlways(groupKey: string, access: PermissionAccess, path: string): boolean;
  /** Take a permanent grant back (file and live). False when it could not be written. */
  revokeAlways(groupKey: string, path: string): boolean;
  /** Tell the session how its request ended (a `<tomo-event type="permission">` turn). */
  notifySession(sessionKey: string, groupKey: string, outcome: PermissionOutcome, body: string): void;
  liveTurnIds(sessionKey: string): readonly number[];
  isTurnLive(id: number): boolean;
  lastTurnId(): number;
  /** The first turn begun on `sessionKey` after turn `after`. */
  firstTurnAfter(sessionKey: string, after: number): number | undefined;
  groupTitle(groupKey: string): string | undefined;
  now?: () => number;
  timeoutMs?: number;
}

/** Append-only record of every request, answer and revocation. */
export class PermissionLedger {
  constructor(readonly path: string) {}

  append(record: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
    } catch (err) {
      log.warn({ err }, "Could not append to the permission ledger");
    }
  }
}

/** The ledger's location under Tomo's home. */
export function permissionLedgerPath(tomoHome: string): string {
  return join(tomoHome, "data", "permissions", "group-requests.jsonl");
}

/**
 * `p` as the harness will grant it: `~` expanded, relative to the workspace,
 * resolved the way the kernel sees it (a missing tail is kept). Null when it
 * cannot be: a `..` segment, a dangling link, a loop.
 */
export function resolveRequestedPath(p: string, workspaceDir: string): string | null {
  const trimmed = p.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  const expanded = expandTilde(trimmed);
  if (expanded.split("/").includes("..")) return null;
  const absolute = normalize(isAbsolute(expanded) ? expanded : join(workspaceDir, expanded));
  const real = resolvedDenyDir(absolute.length > 1 ? absolute.replace(/\/+$/, "") : absolute);
  return real;
}

const ACCESS_WORDS: Record<PermissionAccess, string> = { read: "read", write: "read and write" };

/** The four-line DM the owner gets for a request. */
export function permissionDmText(view: PermissionRequestView, minutes: number): string {
  return [
    `Permission request ${view.code}: a group wants to ${ACCESS_WORDS[view.access]} a path.`,
    `${view.group} · ${view.path}`,
    `Reason (from the agent, not verified): ${view.reason}`,
    `Reply "1 ${view.code}" allow once, "2 ${view.code}" always allow, "3 ${view.code}" deny, or quote this message. Expires in ${minutes} min.`,
  ].join("\n");
}

function oneLine(s: string, max: number): string {
  return s.replace(/\p{C}+/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export class PermissionBroker {
  private readonly pending = new Map<string, PendingRequest>(); // by group key
  private readonly closed: PendingRequest[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>(); // by request id
  private grants: OnceGrant[] = [];
  private readonly lastCall = new Map<string, { text: string; at: number }>();
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: PermissionBrokerDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? PERMISSION_REQUEST_TIMEOUT_MS;
  }

  shutdown(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Every open request, oldest first: what the web card shows. */
  views(): PermissionRequestView[] {
    return [...this.pending.values()].sort((a, b) => a.expiresAt - b.expiresAt).map(viewOf);
  }

  /** The last sandboxed Bash command or refused file-tool call of a session, shown on the card as the trigger. */
  noteCall(sessionKey: string, text: string): void {
    this.lastCall.set(sessionKey, { text: scrubKnownSecrets(text).slice(0, MAX_TRIGGER_LENGTH), at: this.now() });
  }

  async request(input: PermissionRequestInput): Promise<PermissionRequestResult> {
    const path = resolveRequestedPath(input.path, this.deps.workspaceDir);
    if (path === null) return { status: "denied", reason: `${input.path} cannot be resolved to a real path (no \`..\`, no dangling links). Ask for an absolute path.` };
    const assessment = this.deps.assess(input.groupKey, input.sessionKey, path, input.access);
    if (assessment.verdict === "allowed") return { status: "already_allowed", path };
    if (assessment.verdict === "never") return { status: "denied", path, reason: `${assessment.reason}. This is never granted to a group; do not ask again.` };
    const open = this.pending.get(input.groupKey);
    if (open) return { status: "denied", path, reason: `This group already has a request open (${open.code}, for ${open.path}). Wait for its answer before asking again.` };
    const dm = this.deps.ownerDm();
    const card = this.deps.card();
    if (!dm && !card) return { status: "denied", path, reason: "The owner cannot be reached right now (no private chat and no web UI), so nothing was asked." };

    const trigger = this.lastCall.get(input.sessionKey);
    const request: PendingRequest = {
      id: randomUUID(),
      code: this.newCode(),
      group: this.deps.groupTitle(input.groupKey) || input.groupKey,
      path,
      access: input.access,
      reason: oneLine(input.reason, MAX_REASON_LENGTH),
      ...(trigger && this.now() - trigger.at <= TRIGGER_WINDOW_MS ? { command: trigger.text } : {}),
      expiresAt: this.now() + this.timeoutMs,
      groupKey: input.groupKey,
      sessionKey: input.sessionKey,
    };
    this.pending.set(input.groupKey, request);
    const timer = setTimeout(() => this.expire(request.id), this.timeoutMs);
    timer.unref?.();
    this.timers.set(request.id, timer);
    this.deps.ledger.append({ event: "requested", id: request.id, code: request.code, groupKey: request.groupKey,
      sessionKey: request.sessionKey, path, access: request.access, reason: request.reason });
    this.publish();

    let note: string | undefined;
    if (dm) {
      try {
        await dm.channel.send({ chatId: dm.chatId, text: permissionDmText(viewOf(request), Math.round(this.timeoutMs / 60_000)) });
        request.dm = { channel: dm.channel.name, chatId: dm.chatId };
      } catch (err) {
        log.warn({ err, code: request.code }, "Could not DM the owner a permission request");
        if (!card) {
          this.close(request);
          return { status: "denied", path, reason: "The owner could not be reached, so nothing was asked." };
        }
        note = "The owner's private chat could not be reached; the request is waiting in the web UI.";
      }
    }
    return { status: "pending", id: request.id, code: request.code, path, expiresAt: request.expiresAt, ...(note ? { note } : {}) };
  }

  /** The owner's answer (the web card, or a DM reply). */
  decide(id: string, decision: PermissionDecision, via: DecisionChannel): DecideResult {
    const request = [...this.pending.values()].find((r) => r.id === id);
    if (!request) {
      return this.closed.some((r) => r.id === id) ? { ok: false, status: 410, code: "permission_closed" } : { ok: false, status: 409, code: "permission_unknown" };
    }
    if (request.expiresAt <= this.now()) {
      this.expire(id);
      return { ok: false, status: 410, code: "permission_closed" };
    }
    if (decision === "always" && !this.deps.persistAlways(request.groupKey, request.access, request.path)) {
      // The request stays open: the owner can try again, or allow once.
      return { ok: false, status: 503, code: "permission_config_unwritable" };
    }
    this.close(request);
    if (decision === "once") {
      const live = new Set<number>();
      for (const turn of this.deps.liveTurnIds(request.sessionKey)) live.add(turn);
      this.grants.push({ sessionKey: request.sessionKey, groupKey: request.groupKey, path: request.path, access: request.access, turns: live,
        after: this.deps.lastTurnId(), next: null, bindBy: this.now() + this.timeoutMs });
    }
    const outcome = decision === "once" ? "allowed_once" : decision === "always" ? "allowed_always" : "denied";
    this.deps.ledger.append({ event: "decided", id, code: request.code, groupKey: request.groupKey, path: request.path,
      access: request.access, outcome, via });
    this.deps.notifySession(request.sessionKey, request.groupKey, outcome, outcomeText(outcome, request));
    log.info({ code: request.code, outcome, via }, "Permission request answered");
    return { ok: true, outcome };
  }

  /** Take back a permanent grant, and any Allow once for the same path. */
  revoke(groupKey: string, path: string): boolean {
    this.grants = this.grants.filter((g) => !(g.groupKey === groupKey && g.path === path));
    const ok = this.deps.revokeAlways(groupKey, path);
    if (ok) this.deps.ledger.append({ event: "revoked", groupKey, path });
    return ok;
  }

  /**
   * `config` with this session's live Allow-once grants folded into their
   * groups' entries. Called on every tool call of a barred turn (the guard's
   * `groupSandbox` getter), so a grant takes effect on the next call and is
   * gone on the first call after its turns end.
   */
  withOnceGrants(config: GroupSandboxConfig, sessionKey: string): GroupSandboxConfig {
    this.prune();
    if (this.grants.length === 0) return config;
    const live = this.deps.liveTurnIds(sessionKey);
    let groups: Record<string, GroupSandboxEntry> | undefined;
    for (const grant of this.grants) {
      if (!this.activeFor(grant, live)) continue;
      groups ??= { ...config.groups };
      const base = groups[grant.groupKey] ?? { extraRead: [], extraWrite: [], unsandboxed: false };
      groups[grant.groupKey] = {
        ...base,
        extraRead: grant.access === "read" ? [...base.extraRead, grant.path] : base.extraRead,
        extraWrite: grant.access === "write" ? [...base.extraWrite, grant.path] : base.extraWrite,
      };
    }
    return groups ? { ...config, groups } : config;
  }

  private activeFor(grant: OnceGrant, live: readonly number[]): boolean {
    if (live.some((id) => grant.turns.has(id))) return true;
    return grant.next !== null && live.includes(grant.next);
  }

  /** Binds each grant's answer turn once it has begun; drops grants none of whose turns can run again. */
  private prune(): void {
    const now = this.now();
    this.grants = this.grants.filter((g) => {
      g.next ??= this.deps.firstTurnAfter(g.sessionKey, g.after) ?? null;
      if ([...g.turns].some((id) => this.deps.isTurnLive(id))) return true;
      if (g.next !== null) return this.deps.isTurnLive(g.next);
      return now <= g.bindBy;
    });
  }

  /**
   * True when the message was an answer (or a late answer) and must go no
   * further. Runs at the top of `Agent.enqueueMessage`, beside the credential
   * broker. A group message, a non-owner, a tapback and anything not naming a
   * request's code (by text, or by quoting the request) return false at once.
   */
  async handleInbound(channel: Channel, message: IncomingMessage): Promise<boolean> {
    if (message.isGroup) return false;
    if (!CHAT_CHANNELS.includes(channel.name)) return false;
    if (!this.deps.isOwnerSender(channel.name, message.senderId)) return false;
    if (message.rawText === undefined || message.isReaction) return false;
    const text = message.rawText.trim();
    if (text.length > 12) return false;

    let decision: PermissionDecision | undefined;
    let request: PendingRequest | undefined;
    for (const re of CODED_REPLY) {
      const m = re.exec(text);
      if (!m) continue;
      const [digit, code] = /^[123]$/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
      request = this.byCode(code.toUpperCase());
      decision = DIGIT_DECISION[digit];
      break;
    }
    if (!request && message.replyToId && /^[123]$/.test(text)) {
      request = this.quoted(channel, message);
      decision = DIGIT_DECISION[text];
    }
    if (!request || !decision) return false;

    channel.forgetMessage?.(message.chatId, message.id);
    if (!this.isOpen(request)) {
      await this.say(channel, message.chatId, `Permission request ${request.code} is no longer open (it was answered or it expired). Nothing changed.`);
      return true;
    }
    const result = this.decide(request.id, decision, channel.name as DecisionChannel);
    if (!result.ok) {
      await this.say(channel, message.chatId, result.code === "permission_config_unwritable"
        ? `Could not save "always allow" for ${request.code}: the config file could not be written. The request is still open; reply again, or allow once.`
        : `Permission request ${request.code} is no longer open. Nothing changed.`);
      return true;
    }
    await this.say(channel, message.chatId, confirmationText(result.outcome, request));
    return true;
  }

  private byCode(code: string): PendingRequest | undefined {
    return [...this.pending.values()].find((r) => r.code === code) ?? this.closed.find((r) => r.code === code);
  }

  /** The request whose DM `message` quotes, if it quotes one. */
  private quoted(channel: Channel, message: IncomingMessage): PendingRequest | undefined {
    const quotedText = channel.recentMessages?.(message.chatId).find((m) => m.id === message.replyToId && m.fromMe)?.text
      ?? message.text.slice(0, Math.max(0, message.text.length - (message.rawText ?? "").length));
    const all = [...this.pending.values(), ...this.closed];
    return all.find((r) => r.dm?.channel === channel.name && r.dm.chatId === message.chatId
      && quotedText.includes(`Permission request ${r.code}`));
  }

  private isOpen(request: PendingRequest): boolean {
    return this.pending.get(request.groupKey)?.id === request.id && request.expiresAt > this.now();
  }

  private expire(id: string): void {
    const request = [...this.pending.values()].find((r) => r.id === id);
    if (!request) return;
    this.close(request);
    this.deps.ledger.append({ event: "decided", id, code: request.code, groupKey: request.groupKey, path: request.path,
      access: request.access, outcome: "timed_out" });
    this.deps.notifySession(request.sessionKey, request.groupKey, "timed_out", outcomeText("timed_out", request));
  }

  private close(request: PendingRequest): void {
    if (this.pending.get(request.groupKey)?.id === request.id) this.pending.delete(request.groupKey);
    const timer = this.timers.get(request.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(request.id);
    this.closed.push(request);
    if (this.closed.length > MAX_CLOSED) this.closed.shift();
    this.publish();
  }

  private publish(): void {
    try {
      this.deps.card()?.publish(this.views());
    } catch (err) {
      log.warn({ err }, "Could not update the web permission card");
    }
  }

  private newCode(): string {
    const taken = new Set([...this.pending.values(), ...this.closed].map((r) => r.code));
    for (;;) {
      const code = `${CODE_LETTERS[randomInt(CODE_LETTERS.length)]}${CODE_DIGITS[randomInt(CODE_DIGITS.length)]}${CODE_LETTERS[randomInt(CODE_LETTERS.length)]}`;
      if (!taken.has(code)) return code;
    }
  }

  private async say(channel: Channel, chatId: string, text: string): Promise<void> {
    try {
      await channel.send({ chatId, text });
    } catch {
      log.warn({ channel: channel.name }, "Could not send a permission notice");
    }
  }
}

const DIGIT_DECISION: Record<string, PermissionDecision> = { 1: "once", 2: "always", 3: "deny" };

function viewOf(r: PendingRequest): PermissionRequestView {
  return { id: r.id, code: r.code, group: r.group, path: r.path, access: r.access, reason: r.reason,
    ...(r.command ? { command: r.command } : {}), expiresAt: r.expiresAt };
}

function outcomeText(outcome: PermissionOutcome, r: PendingRequest): string {
  const what = `${r.access} access to ${r.path}`;
  switch (outcome) {
    case "allowed_once":
      return `The owner allowed ${what} once (request ${r.code}). It is in effect for the rest of this turn and ends with it: retry what needed it now, in this turn.`;
    case "allowed_always":
      return `The owner always allowed ${what} for this group (request ${r.code}). It is in effect from your next tool call; retry what needed it.`;
    case "denied":
      return `The owner denied ${what} (request ${r.code}). Do not ask again for it on this task; tell the group it is not available.`;
    case "timed_out":
      return `The request for ${what} (${r.code}) got no answer in time, so it is denied. Do not ask again right away; say it is not available for now.`;
  }
}

function confirmationText(outcome: Exclude<PermissionOutcome, "timed_out">, r: PendingRequest): string {
  if (outcome === "allowed_once") return `Allowed once (${r.code}): ${r.group} may ${ACCESS_WORDS[r.access]} ${r.path} for the rest of this turn.`;
  if (outcome === "allowed_always") return `Always allowed (${r.code}): ${r.group} may ${ACCESS_WORDS[r.access]} ${r.path}. Saved to its sandbox config.`;
  return `Denied (${r.code}).`;
}
