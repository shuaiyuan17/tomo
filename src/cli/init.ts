import { Command } from "commander";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { printBanner } from "./banner.js";
import { enableAutostart, isAutostartEnabled, isMacOS } from "./service.js";
import { writeJsonAtomicSync } from "../fs-utils.js";
import { backupConfigIfParseableSync, SDK_SESSIONS_DIR } from "./config/shared.js";
import { SessionStore } from "../sessions/store.js";
import { dmSessionKeyForIdentity } from "../sessions/keys.js";
import { defaultRuntimePaths } from "../runtime-paths.js";
import { DEFAULT_MODEL, PICKER_MODELS } from "../models.js";
import {
  buildInitConfig,
  checkClaudeRuntime,
  ownerSummary,
  probeImsgCli,
  runChannelSetup,
  runInteractiveClaudeLogin,
  type InitChannel,
  type InitPromptPort,
} from "./init-setup.js";

/** @clack/prompts behind the port the channel step is tested through. */
const initPrompts: InitPromptPort = {
  text: (opts) => p.text(opts) as Promise<string | symbol>,
  password: (opts) => p.password(opts) as Promise<string | symbol>,
  confirm: (opts) => p.confirm(opts),
  select: (opts) => p.select(opts) as Promise<string | symbol>,
  multiselect: (opts) => p.multiselect(opts) as Promise<string[] | symbol>,
  isCancel: (value: unknown): value is symbol => p.isCancel(value),
  note: (message, title) => p.note(message, title),
  log: { info: (m) => p.log.info(m), warn: (m) => p.log.warn(m), success: (m) => p.log.success(m) },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const {
  tomoHome: TOMO_HOME,
  workspaceDir: WORKSPACE_DIR,
  sessionsDir: SESSIONS_DIR,
  logsDir: LOGS_DIR,
  configPath: CONFIG_PATH,
  configBackupPath: CONFIG_BACKUP_PATH,
} = defaultRuntimePaths;
const DEFAULTS_DIR = resolve(__dirname, "../../defaults");

type Personality = {
  agentName: string;
  userName: string;
  tone: "chill" | "sharp" | "warm";
};

const TONE_DESCRIPTIONS: Record<string, { vibe: string; style: string }> = {
  chill: {
    vibe: "Relaxed, casual, low-key. Like texting a smart friend who's always chill.",
    style: "Lowercase is fine. Short replies. Emoji when it fits. Never formal.",
  },
  sharp: {
    vibe: "Sharp, witty, slightly opinionated. Like a clever friend who has a take on everything but knows when to shut up.",
    style: "Direct and concise. Has strong opinions. Dry humor. Doesn't sugarcoat.",
  },
  warm: {
    vibe: "Warm, supportive, thoughtful. Like a kind friend who genuinely cares and pays attention.",
    style: "Encouraging but honest. Takes time to understand. Gentle humor. Never dismissive.",
  },
};

export const initCommand = new Command("init")
  .description("Initialize Tomo — set up config and workspace")
  .option("--force", "Overwrite existing config", false)
  .action(async (opts) => {
    printBanner("your personal assistant, powered by Claude");
    p.intro("Welcome to Tomo");

    const configPath = CONFIG_PATH;
    const isReinit = existsSync(configPath) && !opts.force;

    // 1. Prerequisites check (before anything else). Tomo runs Claude Code
    // from the Agent SDK's bundled binary (sessions and /login alike), so no
    // separately installed `claude` on PATH is required — only a login, or an
    // API key.
    const s0 = p.spinner();
    s0.start("Checking the Claude Code runtime");
    const runtime = await checkClaudeRuntime();
    if (runtime.kind === "missing") {
      s0.stop("Claude Code runtime not found");
      p.log.error("Tomo's bundled Claude Code binary did not run. Reinstall with `npm install -g tomo-ai`, or point TOMO_CLAUDE_PATH at a Claude Code binary.");
      p.outro("Setup incomplete");
      process.exit(1);
    }
    if (runtime.kind === "ok") {
      s0.stop(`Claude Code ready (${runtime.version}; ${runtime.auth === "api-key" ? "using ANTHROPIC_API_KEY" : "logged in"})`);
    } else {
      s0.stop(`Claude Code found (${runtime.version}) but not logged in`);
      const login = await p.confirm({ message: "Log in to Claude now? (opens a browser)", initialValue: true });
      if (!p.isCancel(login) && login && runInteractiveClaudeLogin()) {
        p.log.success("Logged in to Claude");
      } else {
        p.log.warn([
          "Continuing without a Claude login. Tomo will not answer until you either:",
          "  • send /login from your owner DM once Tomo is running,",
          "  • set an API key with `tomo config` → Anthropic authentication, or",
          "  • run `tomo init` again.",
        ].join("\n"));
      }
    }

    if (isReinit) {
      p.log.info("Existing config found. Use --force to overwrite.");
    }

    // 2. Safety disclaimer (first-time users only)
    const isFirstTime = !existsSync(configPath);
    if (isFirstTime) {
      p.note(
        [
          "Tomo connects Claude to your messaging channels and gives it tools",
          "that take real actions. Before you start, a few things to know:",
          "",
          "  • AI makes mistakes. It can misunderstand, hallucinate, or act on",
          "    bad input — double-check anything consequential.",
          "  • Prompt injection is real. Messages, emails, or web content Tomo",
          "    reads may contain hidden instructions that try to hijack the agent.",
          "  • Only you (the owner) get answered in DMs. Anyone in a group you",
          "    activate can still steer the agent — activate groups with care.",
          "  • Run Tomo on a machine without sensitive data or credentials you",
          "    can't afford to expose. Treat it like a semi-trusted process.",
          "",
          "We're actively strengthening the guardrails, but you are the last",
          "line of defense.",
        ].join("\n"),
        "Heads up — please read",
      );

      const ack = await p.confirm({
        message: "I understand the risks and want to continue",
        initialValue: true,
      });
      if (p.isCancel(ack) || !ack) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }
    }

    // 3. Personalization
    const personality = isReinit ? null : await askPersonality();
    if (personality === null && !isReinit) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    // 2. Directories
    const s = p.spinner();
    s.start("Creating directory structure");
    const dirs = [
      TOMO_HOME,
      WORKSPACE_DIR,
      join(WORKSPACE_DIR, "memory"),
      join(WORKSPACE_DIR, "tmp"),
      join(TOMO_HOME, "data", "cron"),
      SESSIONS_DIR,
      LOGS_DIR,
    ];
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }
    s.stop("Directory structure ready");

    // 3. Workspace templates
    s.start("Setting up workspace");
    const templates = ["SOUL.md", "AGENT.md", "IDENTITY.md"];
    const copied: string[] = [];
    for (const file of templates) {
      const dest = join(WORKSPACE_DIR, file);
      const src = join(DEFAULTS_DIR, file);
      if ((!existsSync(dest) || opts.force) && existsSync(src)) {
        let content = readFileSync(src, "utf-8");
        if (personality) {
          content = applyPersonality(file, content, personality);
        }
        writeFileSync(dest, content);
        copied.push(file);
      }
    }

    // Skills — write directly to .claude/skills/ with tomo- prefix
    const skillsDir = join(DEFAULTS_DIR, "skills");
    const claudeSkillsDir = join(WORKSPACE_DIR, ".claude", "skills");
    if (existsSync(skillsDir)) {
      for (const skill of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!skill.isDirectory()) continue;
        const destDir = join(claudeSkillsDir, `tomo-${skill.name}`);
        const skillFile = join(destDir, "SKILL.md");
        if (!existsSync(skillFile) || opts.force) {
          mkdirSync(destDir, { recursive: true });
          for (const file of readdirSync(join(skillsDir, skill.name))) {
            copyFileSync(join(skillsDir, skill.name, file), join(destDir, file));
          }
          copied.push(`skill/tomo-${skill.name}`);
        }
      }
    }

    // MEMORY.md with initial content
    const memoryDir = join(WORKSPACE_DIR, "memory");
    const memoryFile = join(memoryDir, "MEMORY.md");
    if (!existsSync(memoryFile) || opts.force) {
      if (personality) {
        writeMemory(memoryDir, personality);
        copied.push("MEMORY.md");
      } else if (!existsSync(memoryFile)) {
        writeFileSync(memoryFile, "");
        copied.push("MEMORY.md");
      }
    }

    if (copied.length > 0) {
      s.stop(`Workspace ready (${copied.join(", ")})`);
    } else {
      s.stop("Workspace unchanged (files already exist)");
    }

    // 4. Configuration
    let channelsPicked: InitChannel[] = [];
    if (!isReinit) {
      p.log.step("Channels");
      const setup = await runChannelSetup(initPrompts, { isMac: isMacOS(), probeImsg: () => probeImsgCli() });
      if (!setup) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }
      channelsPicked = setup.channels;

      const model = await p.select({
        message: "Default model",
        options: PICKER_MODELS.map((m) => ({ value: m.id, label: m.label, hint: m.hint })),
        initialValue: DEFAULT_MODEL,
      });

      if (p.isCancel(model)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      const city = await p.text({
        message: "Your city (for weather in continuity)",
        placeholder: "e.g., Seattle, Tokyo, Los Angeles (use full name, leave empty to skip)",
      });

      if (p.isCancel(city)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      // Group chats are off until a group is activated with this secret.
      const enableGroups = await p.confirm({
        message: "Enable group chats? (each group is activated by sending a secret in it)",
        initialValue: false,
      });

      if (p.isCancel(enableGroups)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      let groupSecret: string | null = null;
      if (enableGroups) {
        const { randomBytes } = await import("node:crypto");
        groupSecret = `tomo-${randomBytes(4).toString("hex")}`;
        p.log.step("Group chat activation");
        p.log.message([
          "To activate Tomo in a group chat, send this secret to the group:",
          "",
          `  ${groupSecret}`,
          "",
          "  Tomo will recognize it and start listening in that group.",
          "  Other groups stay off. You can view this secret later with `tomo config`.",
        ].join("\n"));
      }

      const { config, owner } = buildInitConfig({
        userName: personality?.userName ?? "",
        channels: setup.channels,
        telegramToken: setup.telegramToken,
        telegramUserId: setup.telegramUserId,
        imessageHandles: setup.imessageHandles,
        model: model as string,
        city: (city as string) ?? "",
        groupSecret,
      });

      writeInitConfig(configPath, CONFIG_BACKUP_PATH, config);
      p.log.success("Config saved");
      precreateOwnerSession(owner.name);
      p.note(ownerSummary(owner), "Owner");
    }

    // 4b. Autostart (first-time only, macOS only)
    if (!isReinit && isMacOS()) {
      const autostart = await p.confirm({
        message: "Start Tomo automatically when you log in?",
        initialValue: true,
      });
      if (!p.isCancel(autostart) && autostart) {
        const s = p.spinner();
        s.start("Enabling autostart");
        try {
          await enableAutostart();
          s.stop("Autostart enabled");
        } catch (err) {
          s.stop("Could not enable autostart");
          p.log.warn((err as Error).message);
          p.log.info("You can enable it later with `tomo config` → Autostart.");
        }
      }
    }

    // 5. Summary
    const agentLabel = personality ? personality.agentName : "your assistant";
    p.note(
      [
        `Personality:  ${join(WORKSPACE_DIR, "SOUL.md")}`,
        `Agent rules:  ${join(WORKSPACE_DIR, "AGENT.md")}`,
        `Identity:     ${join(WORKSPACE_DIR, "IDENTITY.md")}`,
        `Memory:       ${join(WORKSPACE_DIR, "memory")}/`,
        `Config:       ${CONFIG_PATH}`,
        `Logs:         ${LOGS_DIR}/`,
      ].join("\n"),
      "Your files",
    );

    const where = channelsPicked.length === 0 ? "" : ` on ${channelsPicked.map((c) => (c === "telegram" ? "Telegram" : "iMessage")).join(" or ")}`;
    if (isAutostartEnabled()) {
      p.outro(`${agentLabel} is running — say hi${where}!`);
    } else {
      p.outro(`Run \`tomo start\` to meet ${agentLabel}!`);
    }
  });

/**
 * Write the config `tomo init` assembled, rotating the previous file into
 * `backupPath` only if it parses.
 *
 * `tomo init --force` overwrites an existing config on purpose, so the .bak
 * is the only copy of what was there. Rotating it content-blind meant a
 * corrupt config replaced a good backup — losing the last recoverable
 * version rather than preserving it. Exported for tests.
 */
export function writeInitConfig(configPath: string, backupPath: string, config: Record<string, unknown>): void {
  mkdirSync(dirname(configPath), { recursive: true });
  backupConfigIfParseableSync(configPath, backupPath);
  writeJsonAtomicSync(configPath, config, { mode: 0o600 });
}

/**
 * Create the owner's `dm:<name>` session entry right away, so every channel
 * connected later (Telegram now, iMessage or the web UI later) binds to this
 * one session instead of a per-channel one. Best-effort: the daemon creates
 * it on first start anyway.
 */
export function precreateOwnerSession(ownerName: string, sessionsDir = SESSIONS_DIR, sdkSessionsDir = SDK_SESSIONS_DIR): void {
  try {
    new SessionStore(sessionsDir, 20, sdkSessionsDir).ensureEntry(dmSessionKeyForIdentity(ownerName));
  } catch {
    // The daemon's first start creates it.
  }
}

async function askPersonality(): Promise<Personality | null> {
  const agentName = await p.text({
    message: "What do you want to name your assistant?",
    placeholder: "Tomo",
    defaultValue: "Tomo",
  });
  if (p.isCancel(agentName)) return null;

  const userName = await p.text({
    message: "What should your assistant call you?",
    placeholder: "Your name or nickname",
  });
  if (p.isCancel(userName)) return null;

  const tone = await p.select({
    message: "What tone should your assistant have?",
    options: [
      { value: "chill" as const, label: "Chill", hint: "relaxed, casual, like texting a friend" },
      { value: "sharp" as const, label: "Sharp", hint: "witty, opinionated, direct" },
      { value: "warm" as const, label: "Warm", hint: "supportive, thoughtful, encouraging" },
    ],
  });
  if (p.isCancel(tone)) return null;

  return {
    agentName: (agentName as string).trim() || "Tomo",
    userName: (userName as string).trim(),
    tone: tone as Personality["tone"],
  };
}

function applyPersonality(file: string, content: string, p: Personality): string {
  // Replace "Tomo" with the chosen agent name in all templates
  if (p.agentName !== "Tomo") {
    content = content.replace(/\bTomo\b/g, p.agentName);
  }

  if (file === "IDENTITY.md") {
    const tone = TONE_DESCRIPTIONS[p.tone];
    content = content.replace(
      /\*\*Vibe:\*\*.*/,
      `**Vibe:** ${tone.vibe}`,
    );
    content = content.replace(
      /\*\*Energy:\*\*.*/,
      `**Energy:** ${tone.style}`,
    );
  }

  return content;
}

function writeMemory(memoryDir: string, personality: Personality): void {
  const date = new Date().toISOString().split("T")[0];

  // User profile
  writeFileSync(join(memoryDir, "user_profile.md"), [
    "---",
    "name: user-profile",
    `description: Key facts about ${personality.userName}`,
    "type: user",
    "---",
    "",
    `Name: ${personality.userName}`,
    `Preferred name to use: ${personality.userName}`,
    `Set up ${personality.agentName} on ${date}.`,
    "",
  ].join("\n"));

  // Work context
  writeFileSync(join(memoryDir, "work_context.md"), [
    "---",
    "name: work-context",
    `description: ${personality.userName}'s current projects and work context`,
    "type: project",
    "---",
    "",
    "(Agent will fill this in as it learns)",
    "",
  ].join("\n"));

  // MEMORY.md index
  const index = [
    `- [User profile](user_profile.md) — ${personality.userName}'s basic info`,
    `- [Work context](work_context.md) — Current projects and goals`,
    "",
  ].join("\n");
  writeFileSync(join(memoryDir, "MEMORY.md"), index);
}
