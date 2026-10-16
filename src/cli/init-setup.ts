import { execFile, spawnSync } from "node:child_process";
import { resolveClaudeExecutable, verifyClaudeLogin } from "../agent/claude-login.js";
import { ownerBindings, ownerSessionKey, OWNER_CHANNELS, type OwnerConfig } from "../owner.js";
import { SessionStore } from "../sessions/store.js";
import { legacySessionKeysForBinding } from "../sessions/keys.js";
import {
  deriveOwnerName,
  promptImessageOwnerHandles,
  promptTelegramUserId,
  type PromptPort,
} from "./config/owner-setup.js";

export type InitChannel = "telegram" | "imessage";

export interface InitAnswers {
  /** Write `auth` (an environment API key the user chose to save). */
  auth?: { method: "api-key"; apiKey: string };
  userName: string;
  channels: InitChannel[];
  telegramToken?: string;
  telegramUserId?: string;
  /** Normalized handles; empty when the user explicitly chose to add them later. */
  imessageHandles?: string[];
  model: string;
  city?: string;
  groupSecret?: string | null;
}

/**
 * The config `tomo init` writes. It carries a single `owner` — never the
 * legacy `identities` — and channel allowlists only list groups, so none is
 * written: the owner's DMs are admitted through `owner`, and groups stay off
 * until activated with the secret.
 */
export function buildInitConfig(a: InitAnswers & { ownerName?: string }): { config: Record<string, unknown>; owner: OwnerConfig } {
  const owner: OwnerConfig = {
    name: a.ownerName ?? deriveOwnerName(a.userName),
    ...(a.userName.trim() ? { displayName: a.userName.trim() } : {}),
    telegram: a.channels.includes("telegram") && a.telegramUserId ? [a.telegramUserId] : [],
    imessage: a.channels.includes("imessage") ? [...(a.imessageHandles ?? [])] : [],
  };
  const channels: Record<string, Record<string, unknown>> = {};
  if (a.channels.includes("telegram") && a.telegramToken) channels.telegram = { token: a.telegramToken };
  if (a.channels.includes("imessage")) channels.imessage = { provider: "imsg" };
  const config: Record<string, unknown> = {
    owner: {
      name: owner.name,
      ...(owner.displayName ? { displayName: owner.displayName } : {}),
      telegram: owner.telegram,
      imessage: owner.imessage,
    },
    channels,
    model: a.model,
  };
  if (a.city?.trim()) config.city = a.city.trim();
  if (a.groupSecret) config.groupSecret = a.groupSecret;
  if (a.auth) config.auth = a.auth;
  return { config, owner };
}

/** Prompts the channel step needs on top of PromptPort. */
export interface InitPromptPort extends PromptPort {
  multiselect(opts: {
    message: string;
    options: Array<{ value: string; label: string; hint?: string }>;
    required?: boolean;
  }): Promise<string[] | symbol>;
  password(opts: { message: string }): Promise<string | symbol>;
  note(message: string, title?: string): void;
}

export interface ChannelSetupResult {
  channels: InitChannel[];
  telegramToken?: string;
  telegramUserId?: string;
  imessageHandles?: string[];
}

/**
 * The channel step of `tomo init`: Telegram, iMessage, or both (the local
 * web UI is always on). Null when cancelled.
 */
export async function runChannelSetup(
  prompts: InitPromptPort,
  opts: { isMac: boolean; probeImsg: () => Promise<boolean> },
): Promise<ChannelSetupResult | null> {
  let channels: InitChannel[];
  for (;;) {
    const picked = await prompts.multiselect({
      message: "Where will you talk to Tomo? (space to select; the local web UI is always on)",
      options: [
        { value: "telegram", label: "Telegram", hint: "a bot you create with @BotFather" },
        { value: "imessage", label: "iMessage", hint: opts.isMac ? "this Mac's Messages app, via the imsg CLI" : "macOS only" },
      ],
      required: true,
    });
    if (prompts.isCancel(picked)) return null;
    channels = (picked as string[]).filter((c): c is InitChannel => c === "telegram" || c === "imessage");
    if (channels.includes("imessage") && !opts.isMac) {
      prompts.log.warn("iMessage needs macOS; skipping it.");
      channels = channels.filter((c) => c !== "imessage");
    }
    if (channels.length > 0) break;
    prompts.log.warn("Pick at least one channel.");
  }

  const result: ChannelSetupResult = { channels };

  if (channels.includes("telegram")) {
    prompts.note([
      "To connect Tomo to Telegram, you need a bot token:",
      "",
      "  1. Open Telegram and message @BotFather",
      "  2. Send /newbot, choose a name and a username ending in \"bot\"",
      "  3. BotFather replies with a token like: 123456:ABC-DEF...",
      "  4. Also send /setprivacy → select your bot → Disable",
      "     (so Tomo can read group messages once you activate a group)",
      "",
      "  Open BotFather: https://t.me/BotFather",
    ].join("\n"), "Telegram");
    for (;;) {
      const token = await prompts.password({ message: "Paste your bot token" });
      if (prompts.isCancel(token)) return null;
      const value = String(token ?? "").trim();
      if (/^\d+:.+$/.test(value)) { result.telegramToken = value; break; }
      prompts.log.warn("That doesn't look like a bot token. It should be like: 123456:ABC-DEF...");
    }
    prompts.log.info("Your Telegram user ID makes you the owner: only you get answered in DMs. Message @userinfobot to find it.");
    const id = await promptTelegramUserId(prompts);
    if (id === null) return null;
    result.telegramUserId = id;
  }

  if (channels.includes("imessage")) {
    prompts.note([
      "Tomo reads and sends iMessages through the imsg CLI on this Mac:",
      "",
      "  1. Install imsg: https://github.com/openclaw/imsg",
      "  2. Give the app that runs Tomo Full Disk Access",
      "     (System Settings → Privacy & Security → Full Disk Access)",
      "  3. Text Tomo from your own phone number or Apple ID email",
    ].join("\n"), "iMessage");
    if (!(await opts.probeImsg())) {
      prompts.log.warn("imsg was not found on PATH. Install it before `tomo start`, or set its path with `tomo config` → Channels → iMessage.");
    }
    const handles = await promptImessageOwnerHandles(prompts);
    if (handles.kind === "cancelled") return null;
    result.imessageHandles = handles.kind === "handles" ? handles.handles : [];
    if (handles.kind === "skipped") {
      prompts.log.warn("No iMessage handle set: iMessage DMs are ignored until you add one with `tomo config` → Owner.");
    }
  }

  return result;
}

/** Shown after the channel step so the owner knows their session id is fixed. */
export function ownerSummary(owner: OwnerConfig): string {
  return [
    `Your session id: ${ownerSessionKey(owner)} — every channel you connect, now or later, joins this one conversation. Don't change owner.name later.`,
    ...(owner.telegram.length ? [`Telegram: ${owner.telegram.join(", ")}`] : []),
    ...(owner.imessage.length ? [`iMessage: ${owner.imessage.join(", ")}`] : []),
  ].join("\n");
}

/** Does the imsg CLI run? (`imsg --version`, 5s.) */
export function probeImsgCli(cliPath = "imsg"): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cliPath, ["--version"], { timeout: 5_000 }, (err) => resolve(!err));
  });
}

export type ClaudeRuntimeCheck =
  | { kind: "ok"; version: string; auth: "logged-in" | "api-key" }
  | { kind: "not-logged-in"; version: string }
  /** The check itself could not run to a verdict (rate limit, network,
   *  timeout): the login may be fine — retry, don't send the user to a
   *  browser login. */
  | { kind: "unverified"; version: string; reason: "rate-limited" | "network" | "timeout"; detail: string }
  | { kind: "missing"; error: string };

const RATE_LIMIT_RE = /rate.?limit|\b429\b|usage limit|overloaded|\b529\b|too many requests/i;
const NETWORK_RE = /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|getaddrinfo|fetch failed|socket hang up|network/i;

/** Why a login verification failed, when it was not about the login. */
export function classifyVerifyFailure(err: unknown): "rate-limited" | "network" | "timeout" | undefined {
  const e = err as { message?: unknown; timedOut?: unknown };
  const message = typeof e?.message === "string" ? e.message : String(err);
  if (e?.timedOut === true) return "timeout";
  if (RATE_LIMIT_RE.test(message)) return "rate-limited";
  if (NETWORK_RE.test(message)) return "network";
  return undefined;
}

/**
 * `tomo init`'s prerequisite. Tomo does NOT need a separately installed and
 * PATH-visible `claude`: sessions run the Agent SDK's bundled Claude Code
 * binary, and since #421 `/login` does too. So check that binary, and whether
 * it is logged in — unless an API key will be used, which needs no login.
 */
export async function checkClaudeRuntime(deps: {
  resolveExecutable?: () => string;
  version?: (exe: string) => Promise<string>;
  verifyLogin?: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ClaudeRuntimeCheck> {
  const exe = (deps.resolveExecutable ?? resolveClaudeExecutable)();
  const getVersion = deps.version ?? ((path: string) => new Promise<string>((resolve, reject) => {
    execFile(path, ["--version"], { timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
  }));
  let version: string;
  try {
    version = await getVersion(exe);
  } catch (err) {
    return { kind: "missing", error: err instanceof Error ? err.message : String(err) };
  }
  if ((deps.env ?? process.env).ANTHROPIC_API_KEY?.trim()) return { kind: "ok", version, auth: "api-key" };
  try {
    await (deps.verifyLogin ?? verifyClaudeLogin)();
    return { kind: "ok", version, auth: "logged-in" };
  } catch (err) {
    const reason = classifyVerifyFailure(err);
    if (reason) return { kind: "unverified", version, reason, detail: err instanceof Error ? err.message : String(err) };
    return { kind: "not-logged-in", version };
  }
}

/** Run `claude auth login` through the bundled binary, interactively. */
export function runInteractiveClaudeLogin(): boolean {
  const res = spawnSync(resolveClaudeExecutable(), ["auth", "login"], { stdio: "inherit" });
  return res.status === 0;
}

// ---------------------------------------------------------------------------
// `tomo init --force` on an existing install
// ---------------------------------------------------------------------------

type RawConfig = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The config `tomo init` writes, MERGED onto an existing one (`--force`).
 * Only what init asks again is replaced: the owner (for the channels picked
 * now — the name is decided by the caller and never silently changed), the
 * picked channels' token / provider, the model, the city if one was given,
 * the group secret if a new one was made, and `auth` when the user chose to
 * save an environment API key. Everything else — `auth`, model overrides,
 * LiteLLM, web, allowlists, passive groups, `cliPath`, plugins, MCP servers,
 * an existing group secret… — is carried over untouched.
 */
export function mergeInitConfig(
  existing: RawConfig | undefined,
  fresh: RawConfig,
  picked: InitChannel[],
): { config: RawConfig; kept: string[]; replaced: string[] } {
  if (!existing || Object.keys(existing).length === 0) {
    return { config: fresh, kept: [], replaced: Object.keys(fresh) };
  }
  const out = clone(existing);
  const replaced = new Set<string>();

  const freshOwner = fresh.owner as { name: string; displayName?: string; telegram: string[]; imessage: string[] };
  const oldOwner = (typeof existing.owner === "object" && existing.owner !== null ? existing.owner : {}) as Record<string, unknown>;
  out.owner = {
    ...clone(oldOwner),
    name: freshOwner.name,
    ...(freshOwner.displayName ? { displayName: freshOwner.displayName } : {}),
    telegram: picked.includes("telegram") ? freshOwner.telegram : (oldOwner.telegram ?? []),
    imessage: picked.includes("imessage") ? freshOwner.imessage : (oldOwner.imessage ?? []),
  };
  replaced.add("owner");

  const freshChannels = (fresh.channels ?? {}) as Record<string, Record<string, unknown>>;
  if (Object.keys(freshChannels).length > 0) {
    const channels = (out.channels && typeof out.channels === "object" ? out.channels : {}) as Record<string, Record<string, unknown>>;
    for (const [name, entry] of Object.entries(freshChannels)) {
      channels[name] = { ...(channels[name] ?? {}), ...entry };
    }
    out.channels = channels;
    replaced.add("channels");
  }
  for (const key of ["model", "city", "groupSecret", "auth"] as const) {
    if (fresh[key] !== undefined) {
      out[key] = clone(fresh[key]);
      replaced.add(key);
    }
  }
  const kept = Object.keys(existing).filter((key) => !replaced.has(key));
  return { config: out, kept, replaced: [...replaced] };
}

/**
 * `owner.name` is the session id. On `--force` with an owner already set, the
 * existing name is kept unless the user explicitly picks the new one — and
 * is told that the old session, its history and cron jobs stay on the old key.
 */
export async function decideOwnerName(
  prompts: PromptPort,
  existingName: string | undefined,
  newName: string,
): Promise<string | null> {
  if (!existingName || existingName.toLowerCase() === newName.toLowerCase()) return existingName ?? newName;
  const choice = await prompts.select({
    message: `Your current session id is dm:${existingName.toLowerCase()}. Keep it?`,
    options: [
      { value: "keep", label: `Keep dm:${existingName.toLowerCase()}`, hint: "recommended: your history, cron jobs and model override stay with you" },
      { value: "new", label: `Start a new session id dm:${newName}`, hint: `the old session and its cron jobs stay on dm:${existingName.toLowerCase()}` },
    ],
  });
  if (prompts.isCancel(choice)) return null;
  return choice === "new" ? newName : existingName;
}

/**
 * Pre-create the owner's `dm:` session — unless that would strand history.
 *
 * - The owner key already has (or had) an entry: nothing to do.
 * - A legacy per-channel session of the owner exists (an install from before
 *   identities, or a raw session from the open-channel era): do NOT
 *   pre-create. An existing owner entry blocks the one-time adoption, which
 *   is what would carry that history, its cron jobs and its model override
 *   into `dm:<owner>`; the daemon's first start does that adoption.
 * - Otherwise create the metadata-only entry, so every channel connected
 *   later joins it.
 */
export function precreateOwnerSessionUnlessAdoptable(
  owner: OwnerConfig,
  sessionsDir: string,
  sdkSessionsDir: string,
): "exists" | "deferred-to-adoption" | "created" {
  const store = new SessionStore(sessionsDir, 20, sdkSessionsDir);
  const key = ownerSessionKey(owner);
  if (store.hasEverHadEntry(key)) return "exists";
  const active = store.listSdkSessionIds().map(([k]) => k);
  const candidates = OWNER_CHANNELS.flatMap((channel) =>
    ownerBindings(owner, channel).flatMap((bound) => legacySessionKeysForBinding(active, channel, bound)));
  if (candidates.length > 0) return "deferred-to-adoption";
  store.ensureEntry(key);
  return "created";
}

/**
 * The API key to offer saving into `config.auth`: one that is set only in
 * this shell's environment. launchd (autostart) does not inherit the shell,
 * so without saving it the daemon started at login would not have it.
 * Undefined when there is nothing to offer (no env key, or config already
 * holds an API key).
 */
export function envApiKeyNeedingSave(
  runtime: ClaudeRuntimeCheck,
  env: NodeJS.ProcessEnv,
  existingConfig: Record<string, unknown> | undefined,
): string | undefined {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key || runtime.kind !== "ok" || runtime.auth !== "api-key") return undefined;
  const saved = (existingConfig?.auth ?? {}) as { method?: unknown; apiKey?: unknown };
  if (saved.method === "api-key" && typeof saved.apiKey === "string" && saved.apiKey.trim()) return undefined;
  return key;
}
