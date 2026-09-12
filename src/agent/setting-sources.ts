import { join } from "node:path";

/**
 * Which filesystem settings the SDK query loads — ONE declaration, because two
 * things depend on it and they must not drift.
 *
 * The query option (`sdk-options.ts`) decides which files the CLI reads, and the
 * barred-turn Bash guard (`bash-sandbox.ts`, via `permissions.ts`) has to scan
 * exactly those files for foreign `PreToolUse` hooks — a hook in a file the CLI
 * loads can rewrite the sandbox wrap away, and a hook in a file it does not load
 * cannot. Deriving the scan list from the same constant is what keeps the guard
 * honest if this list ever grows: add `"local"` here and the guard starts
 * scanning `.claude/settings.local.json` in the same commit.
 *
 * `"project"` only, and `"project"` is required: it is what makes the CLI load
 * `CLAUDE.md`. `"user"` (`~/.claude/settings.json`) is deliberately excluded —
 * the daemon's own Claude Code settings are not this agent's policy.
 */
export const SDK_SETTING_SOURCES = ["project"] as const;

export type SdkSettingSource = (typeof SDK_SETTING_SOURCES)[number];

/** The settings file each loaded source reads, resolved against `workspaceDir`
 *  (the query's `cwd`). A source with no file in the workspace contributes
 *  nothing; the caller treats a missing file as "no hooks". */
export function loadedSettingsFiles(workspaceDir: string): string[] {
  const bySource: Record<SdkSettingSource, string> = {
    project: join(workspaceDir, ".claude", "settings.json"),
  };
  return SDK_SETTING_SOURCES.map((source) => bySource[source]);
}
