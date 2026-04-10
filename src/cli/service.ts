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
  const domain = guiDomain();
  await runLaunchctl(["kickstart", "-k", `${domain}/${LAUNCH_AGENT_LABEL}`]);
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
