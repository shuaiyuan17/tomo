/**
 * The UI gallery: a screenshot of every web UI surface and state, at four viewports and both
 * themes, for reviewing a change by eye. Run with `npm run web:gallery` (see docs/web-ui.md,
 * "Development and validation"); this file is not part of `npm test` or `npm run test:e2e`.
 *
 * Like the E2E tests it boots the real HTTP stack, child process, router, Agent and session store
 * with the deterministic SDK and transport doubles, seeds rich state, and drives Chromium. Shots
 * are named `<surface>-<state>-<viewport>-<theme>.png` and land in GALLERY_DIR. GALLERY_ONLY (a
 * comma-separated list of substrings) shoots only the names that contain one of them.
 *
 * Stability: the browser's clock is frozen at BASE and every seeded timestamp is relative to it,
 * the time zone and locale are fixed, and animations and the caret are off in each shot. What the
 * server computes from its own clock (a registry entry's last activity) still follows real time.
 *
 * A step that cannot be shot (a selector that no longer matches) does not stop the run: it is
 * recorded in `failures.json` beside the shots, and the wrapper script reports it and fails.
 */
import { afterAll, afterEach, it, vi } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

vi.mock("../../src/config.js", async () => (await import("../helpers/agent-mocks.js")).configModuleMock());
vi.mock("../../src/workspace/index.js", async () => (await import("../helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("../helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../../src/logger.js", async () => (await import("../helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, SessionStore, installAgentTestHooks, mockConfig, mockSdk } from "../helpers/agent-harness.js";
import { solidPng } from "../helpers/png.js";
import { seedCostLedger } from "../helpers/cost-fixture.js";
import { WebChannel } from "../../src/channels/web.js";
import { formatReactionMarker } from "../../src/channels/text-utils.js";
import { WebSupervisor } from "../../src/web/supervisor.js";
import { watchBus } from "../../src/watch/bus.js";
import { CronStore } from "../../src/cron/store.js";
import { TodoStore } from "../../src/todos/store.js";
import { DEFAULT_TODOS } from "../../src/todos/limits.js";
import { HomeService } from "../../src/home/service.js";
import { OutgoingMediaStore, outgoingImagesDir } from "../../src/web/outgoing-media.js";
import { uploadsDir } from "../../src/web/uploads.js";
import type { WebPermissionRequest } from "../../src/web/protocol.js";

const OUT = resolve(process.env.GALLERY_DIR || "test-results/gallery");
const ONLY = (process.env.GALLERY_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
mkdirSync(OUT, { recursive: true });

/** The frozen "now" of every shot: Sat 14 Nov 2026, 10:30 in Los Angeles. */
const BASE = Date.UTC(2026, 10, 14, 18, 30, 0);
const TIME_ZONE = "America/Los_Angeles";

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 720 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
} as const;
type Viewport = keyof typeof VIEWPORTS;
type Theme = "light" | "dark";
const THEMES: readonly Theme[] = ["light", "dark"];
const touch = (vp: Viewport) => vp === "phone" || vp === "tablet";

const failures: { name: string; error: string }[] = [];
let shots = 0;
afterAll(() => {
  writeFileSync(join(OUT, "failures.json"), JSON.stringify(failures, null, 2));
  console.log(`gallery: ${shots} shots, ${failures.length} failed step(s) → ${OUT}`);
});

installAgentTestHooks();
let agent: Agent | undefined;
let home: HomeService | undefined;
let supervisor: WebSupervisor;
let browser: Browser | undefined;
let url: string;
let token: string;
afterEach(async () => { await browser?.close(); home?.stop(); await agent?.stop(); browser = undefined; home = undefined; agent = undefined; });

/** The permission cards the gallery shows (src/permissions/broker.ts); empty except during their steps. */
let permissionRequests: WebPermissionRequest[] = [];
const PERMISSION_READ: WebPermissionRequest = {
  id: "7a1c2a9e-0000-4000-8000-000000000001", code: "K7Q", group: "Weekend climbing crew — Yosemite trip planning 2027 (carpool, gear, permits)",
  path: "/Users/alex/Projects/trip-planner", access: "read", reason: "Read the itinerary script so I can add the carpool split to it",
  command: "cd /Users/alex/Projects/trip-planner && python3 scripts/itinerary.py --days 3 --export ./out/itinerary.md", expiresAt: BASE + 4 * 60_000 + 12_000,
};
const PERMISSION_WRITE: WebPermissionRequest = {
  id: "7a1c2a9e-0000-4000-8000-000000000002", code: "M4T", group: "Book club", path: "/Users/alex/Documents/Book club/2027 reading list.numbers",
  access: "write", reason: "Add next month's pick (Piranesi) to the shared reading list", expiresAt: BASE + 2 * 60_000 + 40_000,
};

const LONG_MD = `## Plan for the migration

Here's what I found after going through the **session store** and the \`transcriptFileStem\` helper. The short version: it's *safe*, but there are three edge cases worth knowing about.

### What changes

1. Keys drawn from \`[a-z0-9:-]\` keep their legacy stem
2. Everything else gets a 12-hex suffix:
   - \`dm:alex smith\` → \`dm_alex_smith.3f9a0c2b1d4e.jsonl\`
   - uppercase keys move too, because APFS folds case
     - nested third level item to check indentation
3. Archives follow the active file

> The migration only ever renames — it never rewrites a transcript. If two keys map to the same stem, the family is parked instead.

| Key | Legacy stem | New stem | Moves? |
| --- | --- | --- | :---: |
| \`dm:owner\` | \`dm_owner\` | \`dm_owner\` | No |
| \`imessage:any;-;alex.smith@x\` | \`imessage_any__alex_smith_x\` | \`imessage_any__alex_smith_x.9c1e0f7a2b3d\` | Yes |
| \`telegram:-100123\` | \`telegram_-100123\` | \`telegram_-100123\` | No |

\`\`\`ts
export function transcriptFileStem(key: string): string {
  const legacy = legacyTranscriptFileStem(key);
  if (/^[a-z0-9:-]+$/.test(key)) return legacy;
  return \`\${legacy}.\${createHash("sha256").update(key).digest("hex").slice(0, 12)}\`;
}
\`\`\`

And the shell side:

\`\`\`bash
ls ~/.tomo/sessions/*.jsonl | xargs -n1 basename | sort | uniq -c | sort -rn | head -20 && echo "a very long line that should scroll horizontally rather than wrap inside the code block"
\`\`\`

#### A smaller heading

A link to [the docs](https://example.com/docs/web-ui) and a bare long URL: https://example.com/a/very/long/path/that/goes/on/and/on/without/any/break/points/whatsoever/index.html?query=1&other=2

An unbroken string: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

---

- [x] Read the store
- [ ] Write the tests
- [ ] Ship it

A closing paragraph: the migration only renames files and never rewrites a record. If two keys map to the same file name, the whole family is parked rather than guessed at or merged.`;

/** Group chats, the owner's workspace memory and to-dos, and the scheduled jobs. */
function seedWorkspace(store: SessionStore): string {
  store.setChatTitle("telegram:-100111", "Weekend climbing crew — Yosemite trip planning 2027 (carpool, gear, permits)");
  store.append("telegram:-100111", { role: "user", content: "Who's bringing the second rope?", channel: "telegram", timestamp: BASE - 50_000 });
  store.append("telegram:-100111", { role: "assistant", content: "Sam said he would, and Priya has the spare **60 m** if his is still out for inspection.", channel: "telegram", timestamp: BASE - 45_000 });
  store.setChatTitle("telegram:-2", "Book club");
  store.append("telegram:-2", { role: "user", content: "Next month: Piranesi.", channel: "telegram", timestamp: BASE - 40_000 });
  store.setChatTitle("imessage:any;+;chat123", "Family 👪");
  store.append("imessage:any;+;chat123", { role: "user", content: "Dinner at 7?", channel: "imessage", timestamp: BASE - 30_000 });
  store.updateStats("telegram:-100111", { costUsd: 0.1, inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0, contextUsed: 30_000, contextMax: 200_000 });

  const mem = resolve(mockConfig.workspaceDir, "memory");
  mkdirSync(resolve(mem, "topics"), { recursive: true });
  writeFileSync(resolve(mem, "MEMORY.md"), "# Memory\n\n- Prefers mornings\n- [Garden](topics/garden.md)\n");
  writeFileSync(resolve(mem, "topics", "garden.md"), "# Garden\n\nThree raised beds.\n");

  // The Study's Todos tab: one item per section, one due, one out of snoozes, one of a group, and a short done log.
  const todos = new TodoStore(resolve(mockConfig.tomoHome, "data", "todos"), DEFAULT_TODOS);
  const day = 86_400_000; const now = Date.now();
  const todo = (daysAgo: number, input: Record<string, unknown>) => todos.add({ session: "dm:owner", source: "self", ...input } as Parameters<TodoStore["add"]>[0], now - daysAgo * day);
  const seeds = todo(20, { title: "Order seeds", next: "Place the order with the nursery", waiting_on: "me", review_in: "3d" });
  const shed = todo(16, { title: "Ask about the bike shed", next: "Wait for the reply", waiting_on: "external", review_in: "7d" });
  todos.resolve(seeds.id, { action: "done", by: "self", evidence: "https://example.com/orders/1042" }, now - 9 * day);
  todos.resolve(shed.id, { action: "drop", by: "owner", reason: "The shed is being removed." }, now - 3 * day);
  todo(9, { title: "Review the release PR", next: "Read the diff and approve or request changes", waiting_on: "owner", review_in: "7d", ref: "https://github.com/example/garden/pull/41" });
  todo(1, { title: "Build the trellis", next: "Pick between the south fence and the shed wall", waiting_on: "owner", review_in: "7d", ref: "memory/topics/garden.md", source: "owner" });
  const tap = todo(12, { title: "Call the plumber about the outdoor tap that has been leaking since the frost in early November", next: "Phone during business hours and book the earliest slot that works", waiting_on: "me", review_in: "2d" });
  for (const [daysAgo, reason] of [[10, "Their line was busy all afternoon."], [7, "Closed over the weekend."], [4, "Waiting for the callback they promised."]] as const) {
    todos.resolve(tap.id, { action: "snooze", by: "self", until: "3d", reason }, now - daysAgo * day);
  }
  todo(0.5, { title: "Pick December's book", next: "Post the poll with the three finalists", waiting_on: "me", review_in: "2d", session: "telegram:-2" });
  todo(2, { title: "Upstream fix for the calendar sync bug", next: "Watch the issue; upgrade once a release ships", waiting_on: "external", review_in: "14d", ref: "example/calendar-sync#1203" });

  const cronPath = resolve(mockConfig.tomoHome, "data", "cron", "jobs.json");
  mkdirSync(resolve(cronPath, ".."), { recursive: true });
  const cron = new CronStore(cronPath);
  cron.add({ name: "Morning brief", schedule: { kind: "cron", expr: "30 8 * * *" }, message: "Send the morning brief", sessionKey: "dm:owner" });
  cron.add({ name: "Water the seedlings — check the soil moisture in all three beds first", schedule: { kind: "every", everyMs: 3 * 3_600_000 }, message: "Remind me to water", sessionKey: "dm:owner" });
  cron.add({ name: "Dentist reminder", schedule: { kind: "at", at: new Date(Date.now() + 2 * 3_600_000).toISOString() }, message: "Dentist at 4", sessionKey: "dm:owner", deleteAfterRun: true });
  cron.add({ name: "Book club poll", schedule: { kind: "cron", expr: "0 18 * * 5" }, message: "Post poll", sessionKey: "telegram:-2" });
  cron.add({ name: "Parked one-shot", schedule: { kind: "at", at: "1h" }, message: "Was interrupted", sessionKey: "dm:owner", deleteAfterRun: true });
  // Pin the times to BASE (the store computed them from the real clock), and park and pause two.
  const file = JSON.parse(readFileSync(cronPath, "utf8")) as { jobs?: Record<string, unknown>[] } | Record<string, unknown>[];
  const jobs = Array.isArray(file) ? file : file.jobs ?? [];
  const byName = (name: string) => jobs.find((j) => j.name === name) ?? {};
  for (const job of jobs) { if (typeof job.createdAt === "number") job.createdAt = BASE - 7 * 86_400_000; }
  Object.assign(byName("Morning brief"), { nextRunAt: Date.UTC(2026, 10, 15, 16, 30) });
  Object.assign(byName("Water the seedlings — check the soil moisture in all three beds first"), { nextRunAt: BASE + 3 * 3_600_000 });
  Object.assign(byName("Dentist reminder"), { nextRunAt: BASE + 2 * 3_600_000, schedule: { kind: "at", at: new Date(BASE + 2 * 3_600_000).toISOString() } });
  Object.assign(byName("Book club poll"), { enabled: false, nextRunAt: Date.UTC(2026, 10, 21, 2, 0) });
  Object.assign(byName("Parked one-shot"), { enabled: false, lastStatus: "interrupted", lastRunAt: BASE - 3_600_000, interruptedAt: BASE - 3_600_000, nextRunAt: null });
  writeFileSync(cronPath, JSON.stringify(file, null, 2));
  // The Study's Cost tab: ten weeks of ledger and a quota sample (the server's own clock decides "today").
  seedCostLedger(mockConfig.tomoHome);
  return cronPath;
}

/** The owner's conversation: channels, an image, a reply quote, long markdown, and the SDK's tool calls and a subagent. */
function seedConversation(store: SessionStore): void {
  store.setSdkSessionId("dm:owner", "sdk-rich");
  const dir = resolve(mockConfig.workspaceDir, "memory", "incoming-images", "2026-11-13");
  mkdirSync(dir, { recursive: true });
  const image = resolve(dir, "123533_telegram_test-owner_abcd1234.png");
  writeFileSync(image, solidPng(640, 400));
  const day1 = BASE - 26 * 3_600_000;
  const add = (role: "user" | "assistant", content: string, channel: string, timestamp: number) => store.append("dm:owner", { role, channel, content, timestamp });
  add("user", "Hey, can you look at the transcript migration and tell me if it's safe to ship?", "web", day1);
  add("assistant", "Sure — give me a minute to read through it.", "telegram", day1 + 60_000);
  // A Telegram reaction on it: a pill on the message and one quiet line, not a bubble.
  add("user", formatReactionMarker("love", "Sure — give me a minute to read through it."), "telegram", day1 + 90_000);
  add("assistant", "NO_REPLY", "telegram", day1 + 91_000);
  add("user", `[Sent an image, saved to: ${image}] this is what I see in Finder`, "telegram", day1 + 120_000);
  add("assistant", "Picked up the stale #383 and split it into 3 PRs, the first is merged", "imessage", day1 + 180_000);
  add("user", '[replying to: "Picked up the stale #383 and split it into 3 PRs, the first…"] nice!! and the second?', "imessage", day1 + 240_000);
  const q = BASE - 40 * 60_000;
  add("user", "Walk me through the plan in detail please, with a table of the keys and some code.", "web", q);
  add("assistant", LONG_MD, "web", q + 50_000);
  add("user", "Perfect. One more: a very long message from me to see how my own bubble wraps when it goes on for several lines, including a URL https://example.com/owner/project/pull/513/files#diff-0123456789abcdef0123456789abcdef and `inline code` too.\nSecond line\nThird line", "web", q + 120_000);
  add("assistant", "Short answer: yes.", "web", q + 125_000);
  add("user", formatReactionMarker("like", "Short answer: yes."), "web", q + 130_000);
  add("assistant", "NO_REPLY", "web", q + 131_000);
  store.updateStats("dm:owner", { costUsd: 0.4, inputTokens: 1000, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 0, contextUsed: 128_400, contextMax: 200_000,
    // The SDK's real shape: what counts (sums to contextUsed), deferred tool schemas, the reserve and the free rest.
    contextBreakdown: [{ name: "System prompt", tokens: 9_200 }, { name: "System tools", tokens: 14_400 }, { name: "MCP tools", tokens: 3_400 },
      { name: "MCP tools (deferred)", tokens: 59_000 }, { name: "System tools (deferred)", tokens: 15_500 }, { name: "Custom agents", tokens: 500 },
      { name: "Memory files", tokens: 100 }, { name: "Skills", tokens: 3_800 }, { name: "Messages", tokens: 97_000 },
      { name: "Compact buffer", tokens: 3_000 }, { name: "Free space", tokens: 68_600 }] });

  const line = (type: string, ms: number, content: unknown[]) => JSON.stringify({ type, isSidechain: false, timestamp: new Date(ms).toISOString(), message: { role: type, content } }) + "\n";
  mkdirSync(mockConfig.sdkSessionsDir, { recursive: true });
  // Rollup blocks (Study · Context): one per level, as `tomo lcm` writes them.
  const rollup = (blockTag: string | undefined, ms: number, events: number, text: string) => JSON.stringify({ type: "user", isSidechain: false, isCompactSummary: true,
    ...(blockTag ? { blockTag } : {}), timestamp: new Date(ms).toISOString(), message: { role: "user", content: `[${blockTag ? `${blockTag} — ` : ""}${events} events summarized]\n\n${text}` } }) + "\n";
  const DAY = 86_400_000;
  let body = rollup(undefined, BASE - 200 * DAY, 912, "Earlier conversation, compacted before rollups existed.")
    + rollup("yearly 2025", BASE - 300 * DAY, 4, "Set up the workspace, the first channels and the memory layout.")
    + rollup("monthly 2026-10", BASE - 13 * DAY, 5, "**October**: shipped the web UI's Study, moved cron to its own store, and settled the release cadence.\n\n- Study pages: memory, context, cron\n- Weekly release on Fridays")
    + rollup("weekly 2026-W45", BASE - 6 * DAY, 7, "Transcript rotation landed in three PRs; the session picker was reworked.")
    + rollup("daily 2026-11-12", BASE - 2 * DAY + 3_600_000, 184, "Reviewed the rename paths with a subagent, fixed a clobber on rotation, and wrote the tests.\n\n- `moveWithoutClobber` now guards every rename\n- 412 tests pass")
    + rollup("daily 2026-11-13", BASE - DAY + 3_600_000, 236, "Planned the transcript key migration and drafted the table of keys.");
  body += line("user", q + 100, [{ type: "text", text: "Walk me through" }]);
  const tools: [string, unknown, string, boolean?][] = [
    ["Read", { file_path: "/Users/owner/code/tomo/src/sessions/transcript-names.ts" }, "export function transcriptFileStem(key: string) {\n  ...\n}"],
    ["Grep", { pattern: "transcriptFileStem", path: "src" }, "src/sessions/store.ts:12\nsrc/sessions/transcript-names.ts:40"],
    ["Bash", { command: "cd /Users/owner/code/tomo && npx vitest run tests/session-store.test.ts --reporter=dot 2>&1 | tail -20" }, "Tests  412 passed (412)"],
    ["Bash", { command: "git log --oneline -5" }, "fatal: not a git repository", true],
    ["Edit", { file_path: "/Users/owner/code/tomo/src/sessions/store.ts", old_string: "a", new_string: "b" }, "ok"],
    ["WebFetch", { url: "https://nodejs.org/api/fs.html#fslinkexistingpath-newpath-callback", prompt: "link semantics" }, "Creates a new link..."],
    ["TodoWrite", { todos: [{ content: "Read store", status: "completed" }, { content: "Write tests", status: "in_progress" }] }, "ok"],
    ["Task", { description: "Audit the rename paths", subagent_type: "Explore", prompt: "x" }, "All rename paths go through moveWithoutClobber."],
  ];
  tools.forEach(([name, input, out, isError], k) => {
    body += line("assistant", q + 1000 + k * 1000, [{ type: "tool_use", id: `c${k}`, name, input }]);
    body += line("user", q + 1100 + k * 1000, [{ type: "tool_result", tool_use_id: `c${k}`, content: out, ...(isError ? { is_error: true } : {}) }]);
  });
  body += line("assistant", q + 121_000, [{ type: "tool_use", id: "s1", name: "Read", input: { file_path: "/Users/owner/code/tomo/README.md" } }]);
  body += line("user", q + 121_100, [{ type: "tool_result", tool_use_id: "s1", content: "# Tomo" }]);
  writeFileSync(resolve(mockConfig.sdkSessionsDir, "sdk-rich.jsonl"), body);

  const subagents = resolve(mockConfig.sdkSessionsDir, "sdk-rich", "subagents");
  mkdirSync(subagents, { recursive: true });
  const sub = (type: string, content: unknown[]) => JSON.stringify({ type, message: { model: "claude-opus-5-5", content } }) + "\n";
  writeFileSync(resolve(subagents, "agent-a1.jsonl"),
    sub("user", [{ type: "text", text: "Audit every rename path in src/sessions and report which ones can clobber a live transcript." }]) +
    sub("assistant", [{ type: "text", text: "Checking the **rename paths** now. I'll start with `store.ts`." }]) +
    sub("assistant", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/src/sessions/store.ts" } }]) +
    sub("user", [{ type: "tool_result", tool_use_id: "t1", content: "export class SessionStore {}" }]) +
    sub("assistant", [{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "renameSync" } }]) +
    sub("user", [{ type: "tool_result", tool_use_id: "t2", content: "src/sessions/transcript-rotation.ts:88" }]) +
    sub("assistant", [{ type: "text", text: "All rename paths go through `moveWithoutClobber`:\n\n- rotation\n- migration\n\n```ts\nmoveWithoutClobber(from, to)\n```" }]));
}

function publishTasks(): void {
  // Two compactions since "the daemon started" (Study · Context).
  watchBus.publish({ type: "compact", ts: BASE - 26 * 3_600_000, sessionKey: "dm:owner", preTokens: 171_300, postTokens: 46_900 });
  watchBus.publish({ type: "compact", ts: BASE - 3 * 3_600_000, sessionKey: "dm:owner", preTokens: 182_600, postTokens: 96_200 });
  watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [
    { taskId: "a1", taskType: "local_agent", subagentType: "Explore", description: "Audit the rename paths and find every place a live transcript could be clobbered", ambient: false, background: true, startedAt: BASE - 95_000, summary: "Reading src/sessions/store.ts" },
    // Nested under the subagent: a command it described in words (shown whole), and a command line.
    { taskId: "a3", taskType: "local_bash", description: "Rerun the codex review of #539 via stdin", parentTaskId: "a1", ambient: false, background: true, startedAt: BASE - 40_000 },
    { taskId: "a4", taskType: "local_bash", description: "git log --oneline -5", parentTaskId: "a1", ambient: false, background: true, startedAt: BASE - 30_000 },
    { taskId: "a2", taskType: "local_bash", description: "npm test", ambient: false, background: true, startedAt: BASE - 20_000 },
  ] });
  watchBus.publish({ type: "tasks", sessionKey: "telegram:-100111", tasks: [
    { taskId: "b1", taskType: "local_agent", subagentType: "general-purpose", description: "Compare campsite availability", ambient: false, background: true, startedAt: BASE - 300_000 },
  ] });
}

const usage = () => ({ state: "ok", plan: "max", fetchedAt: BASE, updatedAt: BASE - 60_000, nextRefreshAt: BASE + 30_000, expiresAt: BASE + 1_800_000, serverNow: BASE,
  windows: [
    { id: "five_hour", label: "5-hour", group: "session", scoped: false, percent: 42, resetsAt: BASE + 2 * 3_600_000 + 14 * 60_000, active: true, elevated: false },
    { id: "seven_day", label: "7-day", group: "weekly", scoped: false, percent: 86, resetsAt: BASE + 3 * 86_400_000, active: true, elevated: false },
    { id: "seven_day_opus", label: "Opus", group: "weekly", scoped: true, percent: 12, resetsAt: BASE + 3 * 86_400_000, active: true, elevated: false },
  ] });

/** Seeds the state and boots the real stack (web channel, supervised child, Agent, Home) and Chromium. */
async function boot(options: { conversation: boolean }): Promise<void> {
  watchBus.reset();
  mockConfig.identities = [{ name: "owner", channels: { telegram: "test-owner" }, replyPolicy: "last-active" }];
  const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
  const cronStorePath = seedWorkspace(store);
  if (options.conversation) seedConversation(store);
  const theAgent = agent = new Agent();
  const theHome = home = new HomeService({ workspaceDir: mockConfig.workspaceDir, lastGoodPath: join(mockConfig.tomoHome, "data", "home", "last-good.json"), debounceMs: 20, pollMs: 100 });
  const channel = new WebChannel(mockConfig.owner, undefined, {
    compact: (key, settled) => theAgent.requestOwnerCompact(key, settled),
    stop: (key) => theAgent.stopTurn(key),
    models: { view: (key) => theAgent.webModelView(key), switch: (key, model, from) => theAgent.switchModelFromWeb(key, model, from) },
    home: { view: () => theHome.web(), snapshot: (input) => theHome.deliverSnapshot(input) },
    permissions: { current: () => permissionRequests, decide: () => ({ ok: false, status: 409, code: "permission_unknown" }) },
    outgoingMedia: new OutgoingMediaStore(outgoingImagesDir(mockConfig.workspaceDir), { isPrivate: (path) => path.includes("/memory/private/") }),
    uploads: { dir: uploadsDir(mockConfig.tomoHome), workspaceDir: mockConfig.workspaceDir },
  });
  supervisor = new WebSupervisor(channel, { ...mockConfig, owner: mockConfig.owner, port: 0, cronStorePath });
  channel.attach(supervisor); theAgent.addChannel(channel); theAgent.addChannel(new MockChannel("telegram"));
  theHome.attachWeb({ publish: (event) => channel.events.publish(event), available: () => supervisor.status().state === "running", mayShowTask: (key) => channel.mayShowTask(key) });
  await channel.start();
  theHome.start();
  url = `http://127.0.0.1:${supervisor.status().port}`;
  token = readFileSync(resolve(mockConfig.tomoHome, "web-token"), "utf8").trim();
  browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  publishTasks();
  mockSdk.responseFn = () => "ok";
}

interface PageOptions { noWebgl?: boolean; signedIn?: boolean; hash?: string }

/** A fresh browser context at the viewport and theme, with the clock frozen and usage stubbed. */
async function open(vp: Viewport, theme: Theme, options: PageOptions = {}): Promise<Page> {
  const page = await browser!.newPage({ viewport: VIEWPORTS[vp], deviceScaleFactor: 2, hasTouch: touch(vp), colorScheme: theme,
    timezoneId: TIME_ZONE, locale: "en-US", reducedMotion: "reduce" });
  // A step whose control is gone should fail fast, not hold the pass for Playwright's 30 s.
  page.setDefaultTimeout(8_000);
  await page.clock.setFixedTime(BASE);
  await page.addInitScript(([t, noWebgl]) => {
    try { localStorage.setItem("tomo-theme", t as string); } catch { /* Storage can be unavailable. */ }
    if (noWebgl) {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        return kind.startsWith("webgl") || kind === "experimental-webgl" ? null : (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
      } as typeof original;
    }
  }, [theme, options.noWebgl ?? false] as const);
  await page.route("**/api/v1/usage*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(usage()) }));
  // The screen window is offered only where the daemon can capture one; show it everywhere here.
  await page.route("**/api/v1/bootstrap", async (route) => {
    try {
      const response = await route.fetch({ headers: { ...await route.request().allHeaders(), "sec-fetch-site": "same-origin" } });
      const json = await response.json() as { capabilities?: Record<string, unknown> };
      json.capabilities = { ...json.capabilities, screen: true };
      await route.fulfill({ response, body: JSON.stringify(json) });
    } catch {
      // The server is gone (the disconnected shots): fail the request as the browser would.
      await route.abort("connectionrefused").catch(() => undefined);
    }
  });
  if (options.signedIn === false) { await page.goto(`${url}/${options.hash ?? ""}`); return page; }
  await page.goto(`${url}/?t=${token}${options.hash ?? ""}`);
  await browserExpect(page.getByText("Connected", { exact: true })).toBeAttached();
  await page.waitForTimeout(400);
  return page;
}

/** Back to a clean page of the same context (the session cookie is kept). */
async function reset(page: Page, hash = ""): Promise<void> {
  await page.goto(`${url}/${hash}`);
  await browserExpect(page.getByText("Connected", { exact: true })).toBeAttached();
  await page.waitForTimeout(400);
}

const want = (name: string) => ONLY.length === 0 || ONLY.some((o) => name.includes(o));

interface SnapOptions {
  fullPage?: boolean;
  /** Keep the pointer where the step left it (a hover shot); otherwise it is parked in the corner. */
  keepPointer?: boolean;
  /** Shoot this page instead of the step's own (a second browser context). */
  target?: Page;
}
type Snap = (options?: SnapOptions) => Promise<void>;

/**
 * One gallery step. Runs only when the shot's name passes the filter; a failure (a selector that
 * no longer matches) is recorded in failures.json instead of ending the pass.
 */
async function step(page: Page, vp: Viewport, theme: Theme, surface: string, state: string, act: (snap: Snap) => Promise<void>): Promise<void> {
  const name = `${surface}-${state}-${vp}-${theme}`;
  if (!want(name)) return;
  let shot = false;
  const snap: Snap = async (options = {}) => {
    const target = options.target ?? page;
    if (!options.keepPointer) await target.mouse.move(0, 0).catch(() => undefined);
    await target.waitForTimeout(350);
    await target.screenshot({ path: join(OUT, `${name}.png`), fullPage: options.fullPage, animations: "disabled", caret: "hide" });
    shot = true; shots++;
  };
  try { await resetChrome(page); await act(snap); if (!shot) throw new Error("step took no shot"); } catch (error) {
    failures.push({ name, error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
    console.warn(`gallery: ${name} failed: ${String(error).split("\n")[0]}`);
  }
}

const MENU = /^Menu/;
/** Opens the Tasks rail unless it is already open (the page remembers it across reloads). */
async function openTasks(page: Page): Promise<void> {
  const item = page.getByText(/^Audit the rename paths/).filter({ visible: true });
  if (await item.count() === 0) await page.getByRole("button", { name: /^Tasks/ }).click();
  await item.first().waitFor();
}

/**
 * Every step starts from the same chrome: no menu, dialog or phone drawer (Escape), no screen
 * window and no Tasks rail. The page remembers the last two across reloads, so a step that left
 * one open would otherwise put it on top of every later shot of the pass.
 */
async function resetChrome(page: Page): Promise<void> {
  if (page.isClosed()) return;
  for (let i = 0; i < 2; i++) await page.keyboard.press("Escape");
  const screen = page.locator("#screen-window");
  if (await screen.isVisible()) {
    await page.getByRole("button", { name: "Close screen" }).click();
    await screen.waitFor({ state: "hidden" });
  }
  // Best effort: on a phone the rail's close button cannot always be clicked, and a step that needs
  // the rail closed or open (openTasks) checks for itself, so a rail left open must not fail the step.
  const closeTasks = page.locator("[data-tasks-close]").filter({ visible: true });
  if (await closeTasks.count() > 0) {
    await closeTasks.first().click({ timeout: 2000 }).catch(() => undefined);
    await page.getByText(/^Audit the rename paths/).filter({ visible: true }).first().waitFor({ state: "hidden", timeout: 2000 }).catch(() => undefined);
  }
  // Closing hands focus back to the trigger; a focus shot sets its own focus.
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
}
const history = (page: Page) => page.getByLabel("Conversation history");
const openToolGroup = async (page: Page) => {
  const group = history(page).getByRole("button", { name: /Read a file|tool calls/ }).first();
  await group.click({ timeout: 5000 });
  return group;
};

async function conversationSteps(page: Page, vp: Viewport, theme: Theme): Promise<void> {
  const s = (surface: string, state: string, act: (snap: Snap) => Promise<void>) => step(page, vp, theme, surface, state, act);
  await s("conversation", "rich", async (snap) => { await snap(); });
  await s("conversation", "full", async (snap) => {
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>("[aria-label='Conversation history']")!;
      const shell = document.querySelector<HTMLElement>(".h-dvh");
      if (shell) shell.style.height = "auto";
      el.style.overflow = "visible"; el.style.flex = "none";
    });
    await snap({ fullPage: true });
    await reset(page);
  });
  await s("conversation", "top", async (snap) => {
    await reset(page);
    await history(page).evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(400);
    await snap();
  });
  await s("tools", "open", async (snap) => {
    await reset(page);
    const group = await openToolGroup(page);
    for (const name of [/vitest/, /git log/]) await history(page).getByRole("button", { name }).first().click({ timeout: 3000 });
    await page.waitForTimeout(300);
    await group.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await snap();
  });
  await s("tools", "closed", async (snap) => {
    await reset(page);
    await history(page).getByRole("button", { name: /Read a file|tool calls/ }).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
    await snap();
  });
  if (!touch(vp)) {
    await s("conversation", "hover", async (snap) => {
      await reset(page);
      const bubble = page.locator(".own-bubble").last();
      await bubble.scrollIntoViewIfNeeded();
      await bubble.hover({ timeout: 3000 });
      await snap({ keepPointer: true });
    });
    await s("conversation", "hover-code", async (snap) => {
      await reset(page);
      const code = page.locator("[data-slot=code-block]").first();
      await code.scrollIntoViewIfNeeded();
      await code.hover({ timeout: 3000 });
      await snap({ keepPointer: true });
    });
  }
}

/** A message's actions (reply, react, copy): the reaction picker open, and the composer replying. */
async function messageActionSteps(page: Page, vp: Viewport, theme: Theme): Promise<void> {
  const s = (surface: string, state: string, act: (snap: Snap) => Promise<void>) => step(page, vp, theme, surface, state, act);
  const lastReply = () => history(page).locator("article.message.assistant").filter({ hasText: "Short answer" }).last();
  await s("message", "react", async (snap) => {
    await reset(page);
    const article = lastReply();
    await article.scrollIntoViewIfNeeded();
    await article.hover({ timeout: 3000 });
    await article.getByRole("button", { name: "React" }).click({ timeout: 3000 });
    await page.getByRole("button", { name: "Ha ha" }).waitFor();
    await snap({ keepPointer: true });
  });
  await s("composer", "replying", async (snap) => {
    await reset(page);
    const article = lastReply();
    await article.scrollIntoViewIfNeeded();
    await article.hover({ timeout: 3000 });
    await article.getByRole("button", { name: "Reply" }).click({ timeout: 3000 });
    await page.getByRole("group", { name: "Replying" }).waitFor();
    await snap();
  });
}

/** The permission cards above the composer: one read request with its trigger folded, then two cards with it open. */
async function permissionSteps(page: Page, vp: Viewport, theme: Theme): Promise<void> {
  const s = (surface: string, state: string, act: (snap: Snap) => Promise<void>) => step(page, vp, theme, surface, state, act);
  try {
    await s("permission", "card", async (snap) => {
      permissionRequests = [PERMISSION_READ];
      await reset(page);
      await page.getByTestId("permission-card").first().waitFor();
      await snap();
    });
    await s("permission", "two-open", async (snap) => {
      permissionRequests = [PERMISSION_WRITE, PERMISSION_READ];
      await reset(page);
      await page.getByRole("button", { name: "Triggering call" }).click();
      await page.waitForTimeout(300);
      await snap();
    });
  } finally { permissionRequests = []; }
}

/** Composer states. Run last: a sent message joins the transcript every later shot would show. */
async function composerSteps(page: Page, vp: Viewport, theme: Theme): Promise<void> {
  const s = (surface: string, state: string, act: (snap: Snap) => Promise<void>) => step(page, vp, theme, surface, state, act);
  await s("composer", "focus", async (snap) => {
    await reset(page);
    const input = page.getByRole("textbox", { name: "Message Tomo" });
    await input.fill("x");
    await input.focus(); await page.keyboard.press("Tab");
    await snap();
  });
  await s("composer", "refused", async (snap) => {
    await reset(page);
    await page.route("**/api/v1/messages", (route) => route.fulfill({ status: 413, contentType: "application/json", body: '{"error":"body_too_large"}' }));
    try {
      await page.getByRole("textbox", { name: "Message Tomo" }).fill("Keep this draft");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForTimeout(500);
      await snap();
    } finally { await page.unroute("**/api/v1/messages"); }
  });
  await s("composer", "uncertain", async (snap) => {
    await reset(page);
    await page.route("**/api/v1/messages", (route) => route.abort("connectionfailed"));
    try {
      await page.getByRole("textbox", { name: "Message Tomo" }).fill("Did this one arrive?");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForTimeout(800);
      await snap();
    } finally { await page.unroute("**/api/v1/messages"); }
  });
  await s("composer", "working", async (snap) => {
    await reset(page);
    let release: (() => void) | undefined;
    mockSdk.responseFn = () => new Promise((r) => { release = () => r("Done now."); });
    try {
      const input = page.getByRole("textbox", { name: "Message Tomo" });
      await input.fill("Kick it off");
      await input.press("Enter");
      await page.waitForTimeout(600);
      await input.fill("A draft typed while Tomo is working on the last one, long enough to wrap onto a second line in the composer, with a little more text to be sure.");
      await page.setInputFiles("input[type=file]", { name: "pic.png", mimeType: "image/png", buffer: solidPng(200, 120) });
      await page.waitForTimeout(600);
      await snap();
    } finally { release?.(); mockSdk.responseFn = () => "ok"; await page.waitForTimeout(600); }
  });
}

async function chromeSteps(page: Page, vp: Viewport, theme: Theme): Promise<void> {
  const s = (surface: string, state: string, act: (snap: Snap) => Promise<void>) => step(page, vp, theme, surface, state, act);
  const phone = vp === "phone";
  if (phone) {
    await s("drawer", "open", async (snap) => {
      await reset(page);
      await page.getByRole("button", { name: MENU }).click();
      await snap();
    });
    await s("drawer", "sessions", async (snap) => {
      await reset(page);
      await page.getByRole("button", { name: MENU }).click();
      await page.getByRole("button", { name: /^Session/ }).click();
      await snap();
    });
  } else {
    await s("sessions", "menu", async (snap) => {
      await reset(page);
      await page.getByRole("button", { name: /^Session/ }).click();
      await page.getByRole("menuitemradio").nth(1).hover();
      await snap({ keepPointer: true });
    });
  }
  await s("tasks", "open", async (snap) => {
    await reset(page);
    await openTasks(page);
    await snap();
  });
  await s("tasks", "subagent", async (snap) => {
    await reset(page);
    await openTasks(page);
    await page.getByText(/^Audit the rename paths/).filter({ visible: true }).first().click();
    await page.waitForTimeout(800);
    await page.getByLabel("Subagent transcript").getByRole("button", { name: /Read a file|tool calls/ }).first().click({ timeout: 3000 }).catch(() => undefined);
    await snap();
  });
  if (!phone) {
    await s("context", "compact", async (snap) => {
      await reset(page);
      watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [] });
      try {
        await page.waitForTimeout(300);
        await page.getByRole("button", { name: "Compact context" }).click({ timeout: 5000 });
        await snap();
        await page.keyboard.press("Escape");
      } finally { publishTasks(); }
    });
    await s("sidebar", "focus", async (snap) => {
      await reset(page);
      for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
      await snap();
    });
  }
  await s("screen", "open", async (snap) => {
    await reset(page);
    await page.getByRole("button", { name: /^Screen/ }).click({ timeout: 5000 });
    await page.waitForTimeout(1200);
    await snap();
    // Close it again (the page remembers it); resetChrome() would too, but a step cleans up after itself.
    await page.getByRole("button", { name: "Close screen" }).click();
    await page.locator("#screen-window").waitFor({ state: "hidden" });
  });
  // In a context of its own: the chosen conversation is remembered, and every later shot is of the owner's.
  await s("group", "readonly", async (snap) => {
    const group = await open(vp, theme);
    try {
      if (phone) await group.getByRole("button", { name: MENU }).click();
      await group.getByRole("button", { name: /^Session/ }).click();
      await group.getByRole("menuitemradio", { name: /climbing/ }).click();
      if (phone) await group.keyboard.press("Escape");
      await group.waitForTimeout(600);
      await snap({ target: group });
    } finally { await group.close(); }
  });
  for (const tab of ["todos", "memory", "context", "model", "cost", "cron", "mcp", "config"]) {
    await s("study", tab, async (snap) => {
      await page.goto(`${url}/#study/${tab}`);
      await page.waitForTimeout(900);
      if (tab === "cost") await page.getByRole("list", { name: "Costliest turns" }).waitFor();
      if (tab === "cron") await page.getByText("Dentist reminder", { exact: true }).filter({ visible: true }).first().waitFor();
      await snap();
    });
  }
  await s("study", "cron-confirm", async (snap) => {
    await page.goto(`${url}/#study/cron`);
    // The jobs arrive after the page; wait for them rather than for a fixed time.
    await page.getByText("Dentist reminder", { exact: true }).filter({ visible: true }).first().waitFor();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /^(Pause|Delete)/ }).filter({ visible: true }).first().click();
    await snap();
    await page.keyboard.press("Escape");
  });
  // The scheduled jobs list sits under the running tasks in the Tasks rail (an overlay on a phone).
  await s("scheduled", "list", async (snap) => {
    await reset(page);
    await openTasks(page);
    await page.getByText("Scheduled", { exact: true }).first().evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(300);
    await snap();
  });
  await s("home", "room", async (snap) => {
    await page.goto(`${url}/#home`);
    await page.waitForTimeout(4000);
    await snap();
  });
  if (phone) {
    await s("home", "drawer", async (snap) => {
      await page.goto(`${url}/#home`);
      await page.waitForTimeout(2000);
      await page.getByRole("button", { name: MENU }).click();
      await snap();
      await page.keyboard.press("Escape");
    });
  }
}

for (const vp of Object.keys(VIEWPORTS) as Viewport[]) for (const theme of THEMES) {
  it(`${vp} ${theme}`, async () => {
    await boot({ conversation: true });
    const page = await open(vp, theme);
    await conversationSteps(page, vp, theme);
    await messageActionSteps(page, vp, theme);
    await permissionSteps(page, vp, theme);
    await chromeSteps(page, vp, theme);
    await composerSteps(page, vp, theme);
    await page.close();
    await step(page, vp, theme, "home", "nowebgl", async (snap) => {
      const noGl = await open(vp, theme, { noWebgl: true, hash: "#home" });
      try { await noGl.waitForTimeout(2500); await snap({ target: noGl }); } finally { await noGl.close(); }
    });
    await step(page, vp, theme, "locked", "default", async (snap) => {
      const anonymous = await open(vp, theme, { signedIn: false });
      try { await anonymous.waitForTimeout(800); await snap({ target: anonymous }); } finally { await anonymous.close(); }
    });
  });
}

it("empty chat", async () => {
  await boot({ conversation: false });
  for (const vp of Object.keys(VIEWPORTS) as Viewport[]) for (const theme of THEMES) {
    if (!want(`chat-empty-${vp}-${theme}`)) continue;
    const page = await open(vp, theme);
    await step(page, vp, theme, "chat", "empty", async (snap) => { await snap(); });
    await page.close();
  }
});

it("disconnected", async () => {
  await boot({ conversation: true });
  const pages: [Page, Viewport, Theme][] = [];
  for (const vp of Object.keys(VIEWPORTS) as Viewport[]) for (const theme of THEMES) {
    if (want(`connection-disconnected-${vp}-${theme}`)) pages.push([await open(vp, theme), vp, theme]);
  }
  if (pages.length === 0) return;
  await supervisor.stop();
  await pages[0][0].waitForTimeout(1500);
  for (const [page, vp, theme] of pages) await step(page, vp, theme, "connection", "disconnected", async (snap) => { await snap(); });
});
