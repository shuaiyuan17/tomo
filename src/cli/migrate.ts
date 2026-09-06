import { Command } from "commander";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DIR } from "../workspace/index.js";

interface OpenClawMessage {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }>;
    timestamp?: number;
  };
}

export const migrateCommand = new Command("migrate")
  .description("Import conversation history from other platforms");

migrateCommand
  .command("openclaw <file>")
  .description("Import an OpenClaw session as conversation context")
  .option("--dry-run", "Preview without writing", false)
  .action((file, opts) => {
    if (!existsSync(file)) {
      console.error(`File not found: ${file}`);
      process.exit(1);
    }

    const raw = readFileSync(file, "utf-8").trim();
    const lines = raw.split("\n");

    // Parse messages
    const textMessages: { role: string; text: string; timestamp: string }[] = [];
    for (const line of lines) {
      try {
        const obj: OpenClawMessage = JSON.parse(line);
        if (obj.type !== "message" || !obj.message) continue;

        const role = obj.message.role;
        if (role !== "user" && role !== "assistant") continue;

        const text = obj.message.content
          ?.filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!)
          .join("\n");

        if (!text) continue;
        textMessages.push({ role, text, timestamp: obj.timestamp });
      } catch {
        // Skip malformed lines
      }
    }

    if (textMessages.length === 0) {
      console.log("No text messages found.");
      return;
    }

    console.log(`Found ${textMessages.length} messages\n`);

    // Build conversation summary
    const conversationLines: string[] = [];
    for (const m of textMessages) {
      const label = m.role === "user" ? "User" : "Assistant";
      const ts = new Date(m.timestamp).toLocaleString();
      // Truncate very long messages
      const text = m.text.length > 500 ? m.text.slice(0, 500) + "..." : m.text;
      conversationLines.push(`[${ts}] ${label}: ${text}`);
    }

    const summary = [
      "---",
      "name: imported-conversation",
      "description: Conversation history imported from OpenClaw",
      "type: reference",
      "---",
      "",
      "# Imported Conversation (OpenClaw)",
      "",
      `Imported on ${new Date().toISOString().split("T")[0]} — ${textMessages.length} messages.`,
      "",
      "## Conversation",
      "",
      ...conversationLines,
      "",
    ].join("\n");

    if (opts.dryRun) {
      console.log(summary);
      console.log("\nRe-run without --dry-run to import.");
      return;
    }

    // Write to memory. `MEMORY_DIR` is derived from runtime-paths, so it
    // honours `TOMO_WORKSPACE`; this used to re-derive
    // `~/.tomo/workspace/memory` from `homedir()` and therefore imported the
    // conversation into a directory the daemon does not read — the command
    // then printed the path it had written and said Tomo would see it on the
    // next message, which on any relocated workspace was simply untrue.
    const memoryDir = MEMORY_DIR;
    mkdirSync(memoryDir, { recursive: true });
    const filename = `imported-openclaw-${Date.now()}.md`;
    const filepath = join(memoryDir, filename);
    writeFileSync(filepath, summary);

    // Update MEMORY.md index
    const memoryIndex = join(memoryDir, "MEMORY.md");
    const indexLine = `- [OpenClaw import](${filename}) — ${textMessages.length} messages from previous assistant\n`;
    if (existsSync(memoryIndex)) {
      const existing = readFileSync(memoryIndex, "utf-8");
      writeFileSync(memoryIndex, existing + indexLine);
    } else {
      writeFileSync(memoryIndex, indexLine);
    }

    console.log(`Written to: ${filepath}`);
    console.log(`Added to MEMORY.md index`);
    console.log(`\nTomo will see this conversation in its memory on the next message.`);
  });
