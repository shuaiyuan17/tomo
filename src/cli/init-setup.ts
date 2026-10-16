import { execFile, spawnSync } from "node:child_process";
import { resolveClaudeExecutable, verifyClaudeLogin } from "../agent/claude-login.js";
import { ownerSessionKey, type OwnerConfig } from "../owner.js";
import {
  deriveOwnerName,
  promptImessageOwnerHandles,
  promptTelegramUserId,
  type PromptPort,
} from "./config/owner-setup.js";

export type InitChannel = "telegram" | "imessage";

export interface InitAnswers {
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
export function buildInitConfig(a: InitAnswers): { config: Record<string, unknown>; owner: OwnerConfig } {
  const owner: OwnerConfig = {
    name: deriveOwnerName(a.userName),
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
  | { kind: "missing"; error: string };

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
  } catch {
    return { kind: "not-logged-in", version };
  }
}

/** Run `claude auth login` through the bundled binary, interactively. */
export function runInteractiveClaudeLogin(): boolean {
  const res = spawnSync(resolveClaudeExecutable(), ["auth", "login"], { stdio: "inherit" });
  return res.status === 0;
}
