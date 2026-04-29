import * as p from "@clack/prompts";
import { loadConfig, saveConfig } from "./shared.js";

export async function configGroups(): Promise<void> {
  const cfg = loadConfig();
  const secret = cfg.groupSecret as string | null | undefined;

  if (!secret) {
    p.log.info("Group chat support is disabled (no secret configured).");
    const enable = await p.confirm({ message: "Enable group chat support?" });
    if (p.isCancel(enable) || !enable) return;

    const { randomBytes } = await import("node:crypto");
    const newSecret = `tomo-${randomBytes(4).toString("hex")}`;
    cfg.groupSecret = newSecret;
    saveConfig(cfg);
    p.log.success("Group chat enabled!");
    p.log.message([
      "Send this secret in any group chat to activate Tomo there:",
      "",
      `  ${newSecret}`,
      "",
      "Tomo will confirm and start listening in that group.",
    ].join("\n"));
    return;
  }

  p.log.message([
    "Group chat is enabled. Send this secret in a group to activate Tomo:",
    "",
    `  ${secret}`,
  ].join("\n"));

  const action = await p.select({
    message: "Group chat settings",
    options: [
      { value: "regenerate", label: "Regenerate secret" },
      { value: "disable", label: "Disable group chat" },
      { value: "back", label: "Back" },
    ],
  });
  if (p.isCancel(action) || action === "back") return;

  if (action === "regenerate") {
    const { randomBytes } = await import("node:crypto");
    const newSecret = `tomo-${randomBytes(4).toString("hex")}`;
    cfg.groupSecret = newSecret;
    saveConfig(cfg);
    p.log.success(`New secret: ${newSecret}`);
    p.log.warn("Existing groups stay active. New groups need the new secret.");
  }

  if (action === "disable") {
    const confirm = await p.confirm({ message: "Disable group chat? Existing activated groups will stop working." });
    if (p.isCancel(confirm) || !confirm) return;
    delete cfg.groupSecret;
    saveConfig(cfg);
    p.log.success("Group chat disabled");
  }
}
