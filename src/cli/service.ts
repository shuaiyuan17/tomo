import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

export const LAUNCH_AGENT_LABEL = "ai.tomo";
export const LAUNCH_AGENT_PLIST_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${LAUNCH_AGENT_LABEL}.plist`,
);

const TOMO_HOME = join(homedir(), ".tomo");
const PID_FILE = join(TOMO_HOME, "tomo.pid");

export function isMacOS(): boolean {
  return process.platform === "darwin";
}

export function isAutostartEnabled(): boolean {
  return isMacOS() && existsSync(LAUNCH_AGENT_PLIST_PATH);
}

export async function enableAutostart(): Promise<void> {
  if (!isMacOS()) {
    throw new Error("Autostart is only supported on macOS.");
  }

  stopPidfileTomo();

  const plist = buildPlist();
  mkdirSync(dirname(LAUNCH_AGENT_PLIST_PATH), { recursive: true });
  writeFileSync(LAUNCH_AGENT_PLIST_PATH, plist);

  const domain = guiDomain();

  // Idempotent: if a previous job is still loaded, bootout first so bootstrap succeeds.
  await runLaunchctl(["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`], { ignoreFailure: true });
  try {
    await runLaunchctl(["bootstrap", domain, LAUNCH_AGENT_PLIST_PATH]);
  } catch (err) {
    // Roll back the plist so isAutostartEnabled() doesn't report a half-installed state.
    try { unlinkSync(LAUNCH_AGENT_PLIST_PATH); } catch { /* ignore */ }
    throw err;
  }
}

export async function disableAutostart(): Promise<void> {
  if (!isMacOS()) {
    throw new Error("Autostart is only supported on macOS.");
  }

  const domain = guiDomain();
  await runLaunchctl(["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`], { ignoreFailure: true });

  if (existsSync(LAUNCH_AGENT_PLIST_PATH)) {
    unlinkSync(LAUNCH_AGENT_PLIST_PATH);
  }
}

export async function restartAutostart(): Promise<void> {
  if (!isMacOS()) {
    throw new Error("Autostart is only supported on macOS.");
  }
  if (!existsSync(LAUNCH_AGENT_PLIST_PATH)) {
    throw new Error(
      "Autostart is not enabled. Run `tomo config` → Autostart to enable it, or `tomo start` to run manually.",
    );
  }
  const domain = guiDomain();
  const oldPid = readPidFile();

  // Happy path: service is loaded → kickstart restarts it in place.
  // If the plist is on disk but the service isn't loaded (e.g. after `tomo stop`
  // which calls bootout), kickstart fails — bootstrap it from the plist instead.
  try {
    await runLaunchctl(["kickstart", "-k", `${domain}/${LAUNCH_AGENT_LABEL}`]);
  } catch {
    await runLaunchctl(["bootstrap", domain, LAUNCH_AGENT_PLIST_PATH]);
  }

  // If the running tomo wasn't actually the launchd-managed instance (e.g.
  // started via `tomo start` directly), kickstart -k won't reach it. SIGTERM
  // the PID-file PID directly so it exits and launchd can take over.
  if (oldPid !== null && isAlive(oldPid)) {
    try { process.kill(oldPid, "SIGTERM"); } catch { /* already dead */ }
  }

  // kickstart returns as soon as SIGTERM is sent; wait for the old process to
  // actually exit and a new one to come up before reporting success. Graceful
  // shutdown can take tens of seconds if SIGTERM lands mid-turn (agent waits
  // for the in-flight assistant response to finish before closing).
  const timeoutSec = 60;
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (oldPid !== null && isAlive(oldPid)) continue;
    const newPid = readPidFile();
    if (newPid !== null && newPid !== oldPid) return;
  }
  throw new Error(
    `Restart didn't complete within ${timeoutSec}s (old PID ${oldPid ?? "?"} still alive or no new PID file yet). Check \`tomo status\` and logs.`,
  );
}

function readPidFile(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const n = Number(readFileSync(PID_FILE, "utf-8").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Unload the running LaunchAgent job without removing the plist.
 * The service stops now, but will come back at next login.
 * Use disableAutostart() to remove permanently.
 */
export async function stopLaunchdJob(): Promise<void> {
  if (!isMacOS()) {
    throw new Error("Autostart is only supported on macOS.");
  }
  const domain = guiDomain();
  await runLaunchctl(["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`], { ignoreFailure: true });
}

function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

async function runLaunchctl(
  args: string[],
  opts: { ignoreFailure?: boolean } = {},
): Promise<void> {
  try {
    await execFileAsync("launchctl", args);
  } catch (err) {
    if (opts.ignoreFailure) return;
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || "").toString().trim();
    throw new Error(`launchctl ${args.join(" ")} failed: ${detail}`, { cause: err });
  }
}

function stopPidfileTomo(): void {
  if (!existsSync(PID_FILE)) return;
  try {
    const pid = Number(readFileSync(PID_FILE, "utf-8").trim());
    if (!isNaN(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    unlinkSync(PID_FILE);
  } catch {
    /* best effort */
  }
}

function buildPlist(): string {
  const nodePath = escapeXml(process.execPath);
  const cliPath = escapeXml(resolveCliPath());
  const home = escapeXml(homedir());
  const logDir = join(homedir(), ".tomo", "logs");
  mkdirSync(logDir, { recursive: true });
  const tomoLogPath = escapeXml(join(logDir, "tomo.log"));
  const stdoutPath = escapeXml(join(logDir, "launchd.out.log"));
  const stderrPath = escapeXml(join(logDir, "launchd.err.log"));

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${cliPath}</string>
        <string>start</string>
        <string>--foreground</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${home}</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>TOMO_LOG_FILE</key>
        <string>${tomoLogPath}</string>
    </dict>

    <key>StandardOutPath</key>
    <string>${stdoutPath}</string>

    <key>StandardErrorPath</key>
    <string>${stderrPath}</string>

    <key>WorkingDirectory</key>
    <string>${home}</string>
</dict>
</plist>
`;
}

function resolveCliPath(): string {
  const argv1 = process.argv[1];
  if (!argv1) {
    throw new Error("Cannot determine tomo CLI path (process.argv[1] is empty).");
  }
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
