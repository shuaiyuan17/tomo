import { join } from "node:path";
import { log } from "../../logger.js";
import { isTodoStoreWrite } from "../todo-store-guard.js";

/**
 * Sub-sessions do not write memory: the main session writes it from their
 * reports (11/24 decision). The first line of that is the prompt, which
 * carries no memory instructions at all; this PreToolUse guard is the second.
 * It denies, on a task session, direct writes to `<workspace>/memory/` and to
 * the workspace prompt files — the same write detection as the todo-store
 * guard (file tools by path; Bash redirections and writer verbs by target).
 * Reading stays open: a task may look things up in memory.
 *
 * Like the todo guard, the Bash arm is a text filter and cannot be complete;
 * it guards against habit, not against an adversary.
 */
export const SUBSESSION_MEMORY_WRITE_DENIAL =
  "Sub-sessions don't write Tomo's memory or the workspace prompt files (memory/, SOUL.md, AGENT.md, IDENTITY.md, CONTINUITY.md). Put anything worth remembering in your task_finish report; the main session decides what to keep. Reading them is fine.";

export const PROTECTED_PROMPT_FILES = ["SOUL.md", "AGENT.md", "IDENTITY.md", "CONTINUITY.md"] as const;

/** The paths a task session may not write. Exported for tests. */
export function protectedRoots(workspaceDir: string): string[] {
  return [join(workspaceDir, "memory"), ...PROTECTED_PROMPT_FILES.map((f) => join(workspaceDir, f))];
}

/** Would this call write memory or a prompt file? Exported for tests. */
export function isMemoryWrite(toolName: string, toolInput: unknown, ctx: { cwd: string; workspaceDir: string }): boolean {
  return protectedRoots(ctx.workspaceDir).some((root) => isTodoStoreWrite(toolName, toolInput, { cwd: ctx.cwd, todosDir: root }));
}

export function subsessionMemoryGuardHooks(sessionKey: string, cwd: string, workspaceDir: string) {
  return {
    PreToolUse: [{
      onFailure: "block" as const,
      hooks: [async (input: { tool_name: string; tool_input: unknown }) => {
        let denied: boolean;
        try {
          denied = isMemoryWrite(input.tool_name, input.tool_input, { cwd, workspaceDir });
        } catch (err) {
          // Judgement failed: deny only a call whose input names a protected path.
          let text: string;
          try { text = JSON.stringify(input.tool_input) ?? ""; } catch { text = String(input.tool_input); }
          denied = protectedRoots(workspaceDir).some((root) => text.includes(root)) || /workspace\/memory(?![\w-])/.test(text);
          log.warn({ err, key: sessionKey, tool: input.tool_name, denied }, "Sub-session memory guard failed to judge a tool call");
        }
        if (!denied) return {};
        log.warn({ key: sessionKey, tool: input.tool_name }, "Blocked a sub-session's write to memory or a prompt file");
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: SUBSESSION_MEMORY_WRITE_DENIAL,
          },
        };
      }],
    }],
  };
}
