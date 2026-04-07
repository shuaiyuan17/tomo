import { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import { SessionStore } from "../sessions/store.js";

const TOMO_HOME = join(homedir(), ".tomo");
const SESSIONS_DIR = join(TOMO_HOME, "data", "sessions");

export const sessionsCommand = new Command("sessions")
  .description("Manage chat sessions");

sessionsCommand
  .command("list")
  .description("List all sessions")
  .action(() => {
    const store = new SessionStore(SESSIONS_DIR, 0);
    const entries = store.listAllSessions();

    if (entries.length === 0) {
      console.log("No sessions.");
      return;
    }

    const active = entries.filter((e) => e.unlinkedAt === null);
    const unlinked = entries.filter((e) => e.unlinkedAt !== null);

    if (active.length > 0) {
      console.log("Active sessions:\n");
      for (const e of active) {
        const age = formatAge(Date.now() - e.createdAt);
        const lastActive = formatAge(Date.now() - e.lastActiveAt);
        console.log(`  ${e.channelKey}`);
        console.log(`    Session:  ${e.sdkSessionId}`);
        console.log(`    Created:  ${age} ago`);
        console.log(`    Last use: ${lastActive} ago`);
        if (e.stats) {
          const s = e.stats;
          const pct = s.contextMax > 0 ? Math.round((s.contextUsed / s.contextMax) * 100) : 0;
          console.log(`    Queries:  ${s.totalQueries}`);
          console.log(`    Cost:     $${s.totalCostUsd.toFixed(4)}`);
          console.log(`    Tokens:   ${s.totalInputTokens} in / ${s.totalOutputTokens} out`);
          console.log(`    Context:  ${s.contextUsed}/${s.contextMax} (${pct}%)`);
        }
        console.log();
      }
    }

    if (unlinked.length > 0) {
      console.log("Unlinked sessions (pending deletion):\n");
      for (const e of unlinked) {
        const expiresIn = e.expiresAt ? formatAge(e.expiresAt - Date.now()) : "?";
        console.log(`  ${e.channelKey} (was)`);
        console.log(`    Session:  ${e.sdkSessionId}`);
        console.log(`    Expires:  in ${expiresIn}`);
        console.log();
      }
    }
  });

sessionsCommand
  .command("clear [key]")
  .description("Unlink a session (or all sessions)")
  .action((key) => {
    const store = new SessionStore(SESSIONS_DIR, 0);

    if (key) {
      if (!store.getSdkSessionId(key)) {
        console.error(`No active session for "${key}"`);
        process.exit(1);
      }
      store.clearSdkSessionId(key);
      console.log(`Unlinked session for "${key}" (will be deleted in 30 days)`);
    } else {
      const entries = store.listSdkSessionIds();
      if (entries.length === 0) {
        console.log("No active sessions.");
        return;
      }
      for (const [k] of entries) {
        store.clearSdkSessionId(k);
      }
      console.log(`Unlinked ${entries.length} session(s) (will be deleted in 30 days)`);
    }
  });

function formatAge(ms: number): string {
  if (ms < 0) return "0s";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
