import { Command } from "commander";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { printBanner } from "./banner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOMO_HOME = join(homedir(), ".tomo");
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

    const configPath = join(TOMO_HOME, "config.json");
    const isReinit = existsSync(configPath) && !opts.force;

    // 1. Prerequisites check (before anything else)
    const s0 = p.spinner();
    s0.start("Checking prerequisites");
    const { execSync } = await import("node:child_process");
    try {
      const version = execSync("claude --version 2>/dev/null", { encoding: "utf-8" }).trim();
      s0.stop(`Claude Code found (${version})`);

      const s1 = p.spinner();
      s1.start("Verifying Claude Code authentication");
      try {
        execSync('claude -p "say ok" --max-turns 1 2>/dev/null', {
          encoding: "utf-8",
          timeout: 30_000,
        });
        s1.stop("Claude Code authenticated");
      } catch {
        s1.stop("Claude Code not authenticated");
        p.log.error("Run `claude` in your terminal to log in, then try `tomo init` again.");
        p.outro("Setup incomplete");
        process.exit(1);
      }
    } catch {
      s0.stop("Claude Code not found");
      p.log.error("Claude Code is required. Install it: npm install -g @anthropic-ai/claude-code");
      p.outro("Setup incomplete");
      process.exit(1);
    }

    if (isReinit) {
      p.log.info("Existing config found. Use --force to overwrite.");
    }

    // 2. Personalization
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
      join(TOMO_HOME, "workspace"),
      join(TOMO_HOME, "workspace", "memory"),
      join(TOMO_HOME, "workspace", "tmp"),
      join(TOMO_HOME, "data", "cron"),
      join(TOMO_HOME, "data", "sessions"),
      join(TOMO_HOME, "logs"),
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
      const dest = join(TOMO_HOME, "workspace", file);
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
    const claudeSkillsDir = join(TOMO_HOME, "workspace", ".claude", "skills");
    if (existsSync(skillsDir)) {
      for (const skill of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!skill.isDirectory()) continue;
        const destDir = join(claudeSkillsDir, `tomo-${skill.name}`);
        const destFile = join(destDir, "SKILL.md");
        const srcFile = join(skillsDir, skill.name, "SKILL.md");
        if ((!existsSync(destFile) || opts.force) && existsSync(srcFile)) {
          mkdirSync(destDir, { recursive: true });
          copyFileSync(srcFile, destFile);
          copied.push(`skill/tomo-${skill.name}`);
        }
      }
    }

    // MEMORY.md with initial content
    const memoryDir = join(TOMO_HOME, "workspace", "memory");
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
    if (!isReinit) {
      p.log.step("Telegram setup");
      p.log.message([
        "To connect Tomo to Telegram, you need a bot token:",
        "",
        "  1. Open Telegram and message @BotFather",
        "  2. Send /newbot",
        "  3. Choose a name (e.g., \"My Tomo\")",
        "  4. Choose a username (must end in \"bot\", e.g., \"my_tomo_bot\")",
        "  5. BotFather will reply with a token like: 123456:ABC-DEF...",
        "  6. Also send /setprivacy → select your bot → Disable",
        "     (so Tomo can read group messages)",
        "",
        "  Open BotFather: https://t.me/BotFather",
      ].join("\n"));

      const token = await p.text({
        message: "Paste your bot token",
        placeholder: "123456:ABC-DEF1234ghIkl-zyx57W2v...",
        validate: (val) => {
          if (!val?.trim()) return "Token is required.";
          if (!/^\d+:.+$/.test(val.trim())) return "That doesn't look like a bot token. It should be like: 123456:ABC-DEF...";
        },
      });

      if (p.isCancel(token)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      p.log.message([
        "Your Telegram user ID is needed so only you can message the bot.",
        "",
        "  To find it: message @userinfobot on Telegram — it replies with your ID.",
        "  It looks like: 123456789",
        "",
        "  You can add more allowed users later with `tomo config`.",
      ].join("\n"));

      const telegramUserId = await p.text({
        message: "Your Telegram user ID",
        placeholder: "e.g. 123456789",
        validate: (val) => {
          if (!val?.trim()) return "User ID is required for security.";
          if (!/^\d+$/.test(val.trim())) return "User ID should be a number.";
        },
      });

      if (p.isCancel(telegramUserId)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      const model = await p.select({
        message: "Default model",
        options: [
          { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "fast, recommended" },
          { value: "claude-opus-4-6", label: "Claude Opus 4.6", hint: "most capable" },
          { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "cheapest" },
        ],
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

      // Group chat setup
      const enableGroups = await p.confirm({
        message: "Enable group chat support?",
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
          "  You can view this secret later with `tomo config`.",
        ].join("\n"));
      }

      const userId = (telegramUserId as string).trim();
      const config: Record<string, unknown> = {
        channels: {
          telegram: { token: token as string, allowlist: [userId] },
        },
        model,
      };
      if ((city as string)?.trim()) {
        config.city = (city as string).trim();
      }
      if (groupSecret) {
        config.groupSecret = groupSecret;
      }

      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      p.log.success("Config saved");
    }

    // 5. Summary
    const agentLabel = personality ? personality.agentName : "your assistant";
    p.note(
      [
        `Personality:  ~/.tomo/workspace/SOUL.md`,
        `Agent rules:  ~/.tomo/workspace/AGENT.md`,
        `Identity:     ~/.tomo/workspace/IDENTITY.md`,
        `Memory:       ~/.tomo/workspace/memory/`,
        `Config:       ~/.tomo/config.json`,
        `Logs:         ~/.tomo/logs/`,
      ].join("\n"),
      "Your files",
    );

    p.outro(`Run \`tomo start\` to meet ${agentLabel}!`);
  });

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
