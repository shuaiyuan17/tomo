import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterAll } from "vitest";

// A HOME of its own for every test file, set before the file's imports run.
//
// Every default path the daemon uses hangs off `homedir()` (src/runtime-paths.ts:
// ~/.tomo/config.json, ~/.tomo/data/restart-requests, ~/.claude/projects, ...),
// most of them as module-level consts. Without this, any test that reaches one
// of those defaults without stubbing HOME itself reads and writes the
// developer's REAL ~/.tomo, under a daemon that may be running: an Agent turn
// on `dm:shuai` ends with `takePendingRestartRequest("dm:shuai")` against the
// live request directory, claims the restart the daemon was about to honour,
// and the owner's `tomo restart` silently never happens.
//
// Assigned, not `vi.stubEnv`: a test that calls `vi.unstubAllEnvs()` must fall
// back to THIS home, not to the real one the stub replaced. Tests that pin their
// own HOME with `vi.stubEnv` still work: their unstub lands back here.
//
// One per file, not one per run: test files run in parallel, and a startup
// sweep or a request in one must not see another's.
//
// Under the repo's node_modules/.cache, NOT the temp dir: every group turn is
// granted /tmp and $TMPDIR, so a home inside them would be readable by a group
// sandbox in tests when it never is in production (tests/permission-request
// asks for "~" and expects a refusal). Same reason as the fixtures in
// tests/group-sandbox.test.ts.
//
// Playwright finds its browsers under the home it sees (the e2e and gallery
// suites share this file), so pin the cache it was installed into first —
// read-only, and the same directory `npx playwright install` wrote.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightCacheDir(homedir());
// node:url's URL, not the global: a test file on the happy-dom environment
// replaces the global with one that refuses file: URLs.
const cacheDir = fileURLToPath(new NodeURL("../../node_modules/.cache", import.meta.url));
mkdirSync(cacheDir, { recursive: true });
const testHome = realpathSync.native(mkdtempSync(join(cacheDir, "tomo-test-home-")));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

// Overrides that would point a default path back at the developer's real tree
// (`TOMO_WORKSPACE` outranks HOME in createRuntimePaths), and the identity a
// daemon-spawned shell carries (`TOMO_SESSION_KEY` / `TOMO_DAEMON_PID`, which
// `tomo restart` and `tomo todo` read). Deleted rather than blanked: a blank
// override is reported as ignored, and tests assert on that list.
for (const name of ["TOMO_WORKSPACE", "SESSIONS_DIR", "TOMO_SESSION_KEY", "TOMO_DAEMON_PID"]) {
  delete process.env[name];
}

// And no test launches the real restart helper: under vitest `process.argv[1]`
// is the runner, so a claimed request would spawn a detached `<runner> restart`.
// The tests that exercise the launch mock `spawn` and unset this.
process.env.TOMO_RESTART_HELPER = "off";

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

/** Playwright's default browser cache for `home` (its registry's own rule). */
function playwrightCacheDir(home: string): string {
  if (process.platform === "darwin") return join(home, "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "ms-playwright");
  return join(process.env.XDG_CACHE_HOME ?? join(home, ".cache"), "ms-playwright");
}
