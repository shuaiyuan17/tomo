import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TOMO_DAEMON_PID_ENV, TOMO_SESSION_KEY_ENV } from "../restart-reason.js";
export function restartArguments(reason: string, env: NodeJS.ProcessEnv = process.env) {
  const environment = { ...env };
  delete environment[TOMO_DAEMON_PID_ENV]; delete environment[TOMO_SESSION_KEY_ENV];
  const compiled = fileURLToPath(new URL("../cli.js", import.meta.url));
  const entry = existsSync(compiled) ? compiled : fileURLToPath(new URL("../cli.ts", import.meta.url));
  return { args: [...(entry.endsWith(".ts") ? ["--import", "tsx"] : []), entry, "restart", "--reason", reason], env: environment };
}
/** Uses the existing CLI drain/launchd restart path in a detached worker. */
export function dispatchWebRestart(reason: string, onExit: (failed: boolean) => void): Promise<void> {
  const options = restartArguments(reason);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, options.args, { env: options.env, detached: true, stdio: "ignore" });
    // Spawn only acknowledges dispatch. A later stop/launchd failure must
    // release the supervisor latch so the still-running daemon can retry.
    child.once("exit", (code, signal) => onExit(code !== 0 || signal !== null));
    child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
  });
}
