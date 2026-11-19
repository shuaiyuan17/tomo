import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// request_permission (src/permissions/broker.ts) end to end: the tool's input,
// the owner's three answers, the DM reply rules, the config writer, and the
// grant reaching the guard's next call, executed under a REAL sandbox-exec.
//
//   <root>/tomo-home/config.json                 — the config the writer edits
//   <root>/tomo-home/workspace/                  — the workspace inside it
//   <root>/external/project/file.txt             — outside every default allow
//
// Like tests/group-sandbox.test.ts, the fixture is not under the temp dirs
// every group turn is granted, so "outside" really is outside.
// ---------------------------------------------------------------------------

const fx = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const base = path.join(process.cwd(), "node_modules", ".cache");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, "tomo-perm-req-")));
  const tomoHome = path.join(root, "tomo-home");
  return { root, tomoHome, ws: path.join(tomoHome, "workspace"), external: path.join(root, "external", "project") };
});

const live = vi.hoisted(() => ({
  config: {
    workspaceDir: "", tomoHome: "", sessionsDir: "",
    groupSandbox: { groups: {} as Record<string, { extraRead: string[]; extraWrite: string[]; unsandboxed: boolean }> },
    groupShellAllowlist: [] as string[],
  },
}));
live.config.workspaceDir = fx.ws;
live.config.tomoHome = fx.tomoHome;
live.config.sessionsDir = join(fx.tomoHome, "data", "sessions");

vi.mock("../src/config.js", () => ({ config: live.config }));
vi.mock("../src/workspace/index.js", () => ({
  MEMORY_DIR: join(fx.ws, "memory"),
  PRIVATE_MEMORY_DIR: join(fx.ws, "memory", "private"),
  HOME_SCENE_DIR: join(fx.ws, "home"),
  PRIVATE_MEMORY_SUBDIR: "private",
}));
vi.mock("../src/logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { PermissionBroker, PermissionLedger, permissionDmText } = await import("../src/permissions/broker.js");
const { persistGroupGrant, revokeGroupGrant, newGrantId, findGrant, grantForRequest } = await import("../src/permissions/config-grants.js");
const { buildPermissionTools, permissionToolSchema, PERMISSION_NOT_SANDBOXED } = await import("../src/mcp/permission-tools.js");
const { assessGroupPermission, privateMemoryGuardHooks } = await import("../src/agent/private-memory-guard.js");
const { effectiveGroupSandbox } = await import("../src/agent/group-fs-policy.js");
const { TurnAudienceRegistry } = await import("../src/agent/audience.js");
const { SANDBOX_EXEC_PATH, SANDBOX_SHELL_PATH, shellSingleQuote } = await import("../src/agent/bash-sandbox.js");
type Broker = InstanceType<typeof PermissionBroker>;
type Outcome = "allowed_once" | "allowed_always" | "denied" | "timed_out";

const GROUP = "telegram:-100777";
const OTHER_GROUP = "telegram:-100888";
const OWNER_ID = "4242";
const OWNER_CHAT = "4242";
const CONFIG = join(fx.tomoHome, "config.json");
const BACKUP = join(fx.tomoHome, "config.json.bak");
const LEDGER = join(fx.tomoHome, "data", "permissions", "group-requests.jsonl");
const EXTERNAL = join(fx.external, "file.txt");
const PRIVATE = join(fx.ws, "memory", "private", "note.txt");

mkdirSync(fx.external, { recursive: true });
writeFileSync(EXTERNAL, "EXTERNAL-CONTENT\n");
mkdirSync(join(fx.ws, "memory", "private"), { recursive: true });
writeFileSync(PRIVATE, "PRIVATE\n");
mkdirSync(join(fx.ws, "home"), { recursive: true });
afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

/** A chat channel double: records what it sent, remembers it as recent messages. */
function chatChannel(name = "telegram") {
  const sent: { chatId: string; text: string; id: string }[] = [];
  return {
    name,
    sent,
    async send(m: { chatId: string; text: string }) { sent.push({ ...m, id: `out-${sent.length + 1}` }); },
    recentMessages: (chatId: string) => sent.filter((m) => m.chatId === chatId).map((m) => ({ id: m.id, text: m.text, timestamp: 0, fromMe: true })),
    onMessage() {}, onCommand() {}, startTyping: () => () => {}, async start() {}, async stop() {},
  };
}

interface Harness {
  broker: Broker;
  dm: ReturnType<typeof chatChannel>;
  turns: InstanceType<typeof TurnAudienceRegistry>;
  notes: { sessionKey: string; outcome: Outcome; body: string; onTurnBegin?: (turnId: number) => void }[];
  /** Begins the turn that carries the latest answer, as Agent.processCronMessage does (and reports its id). */
  answerTurn(): number;
  cards: unknown[][];
  now: { t: number };
}

function harness(opts: { timeoutMs?: number; dm?: boolean } = {}): Harness {
  const dm = chatChannel();
  const turns = new TurnAudienceRegistry();
  const notes: Harness["notes"] = [];
  const cards: unknown[][] = [];
  const now = { t: 1_000_000 };
  const target = { configPath: CONFIG, backupPath: BACKUP, live: live.config };
  const broker: Broker = new PermissionBroker({
    ledger: new PermissionLedger(LEDGER),
    workspaceDir: fx.ws,
    assess: (groupKey, sessionKey, path, access) => assessGroupPermission(sandboxFor(broker, sessionKey).groups[groupKey], path, access),
    ownerDm: () => opts.dm === false ? undefined : { channel: dm as never, chatId: OWNER_CHAT },
    card: () => ({ publish: (requests) => cards.push(requests) }),
    isOwnerSender: (_channel, senderId) => senderId === OWNER_ID,
    persistAlways: (groupKey, access, path, grant) => persistGroupGrant(groupKey, access, path, target, grant),
    newGrantId: () => newGrantId(live.config.groupSandbox),
    findGrant: (grantId) => {
      const found = findGrant(live.config.groupSandbox, grantId);
      return found ? { groupKey: found.groupKey, path: found.grant.path } : undefined;
    },
    grantForRequest: (requestId) => grantForRequest(live.config.groupSandbox, requestId)?.grantId,
    revokeAlways: (groupKey, path) => revokeGroupGrant(groupKey, path, target),
    notifySession: (sessionKey, _groupKey, outcome, body, onTurnBegin) => notes.push({ sessionKey, outcome, body, onTurnBegin }),
    liveTurnIds: (key) => turns.liveTurnIds(key),
    isTurnLive: (id) => turns.isLive(id),
    groupTitle: (key) => key === GROUP ? "Weekend project" : undefined,
    now: () => now.t,
    timeoutMs: opts.timeoutMs ?? 300_000,
  });
  const answerTurn = () => {
    const note = notes.at(-1)!;
    const id = turns.begin(note.sessionKey, [GROUP]);
    note.onTurnBegin?.(id);
    return id;
  };
  return { broker, dm, turns, notes, cards, now, answerTurn };
}

/** What the guard applies on `sessionKey`: config (legacy folded in) plus live Allow-once grants when `once` — Agent.groupSandboxFor. */
function sandboxFor(broker: Broker, sessionKey: string, opts: { once: boolean } = { once: true }) {
  const base = effectiveGroupSandbox(live.config.groupSandbox, live.config.groupShellAllowlist);
  return opts.once ? broker.withOnceGrants(base, sessionKey) : base;
}

/** The guard as a group session's live session installs it. */
function guard(broker: Broker, sessionKey = GROUP) {
  const hooks = privateMemoryGuardHooks(sessionKey, () => "group-session", () => [], (opts) => sandboxFor(broker, sessionKey, opts), () => sessionKey,
    (text) => broker.noteCall(sessionKey, text));
  return hooks.PreToolUse[0].hooks[0] as (input: { tool_name: string; tool_input: unknown; agent_id?: string }) => Promise<{
    hookSpecificOutput?: { permissionDecision?: string; updatedInput?: { command?: string } };
  }>;
}

async function readAllowed(broker: Broker, path = EXTERNAL): Promise<boolean> {
  const r = await guard(broker)({ tool_name: "Read", tool_input: { file_path: path } });
  return r.hookSpecificOutput?.permissionDecision !== "deny";
}

function ownerDm(text: string, extra: Record<string, unknown> = {}) {
  return { id: `in-${Math.random()}`, chatId: OWNER_CHAT, senderName: "Owner", senderId: OWNER_ID, text, rawText: text, timestamp: Date.now(), ...extra };
}

async function ask(h: Harness, path = fx.external, access: "read" | "write" = "read") {
  const result = await h.broker.request({ sessionKey: GROUP, groupKey: GROUP, path, access, reason: "read the project's README for the build steps" });
  expect(result.status).toBe("pending");
  return result as Extract<typeof result, { status: "pending" }>;
}

function resetConfig() {
  live.config.groupSandbox.groups = {};
  live.config.groupShellAllowlist = [];
  writeFileSync(CONFIG, `${JSON.stringify({ model: "x", groupSandbox: { groups: {} } }, null, 2)}\n`);
  rmSync(BACKUP, { force: true });
}

beforeEach(() => resetConfig());
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------

describe("the tool's input", () => {
  const schema = z.object(permissionToolSchema);

  it("accepts a path, read or write, and a one-line reason", () => {
    expect(schema.safeParse({ path: "/srv/project", access: "read", reason: "build" }).success).toBe(true);
    expect(schema.safeParse({ path: "~/src/app", access: "write", reason: "fix the test" }).success).toBe(true);
  });

  it.each([
    ["an empty path", { path: "  ", access: "read", reason: "x" }],
    ["a NUL in the path", { path: "/srv/a\0b", access: "read", reason: "x" }],
    ["an unknown access", { path: "/srv/project", access: "execute", reason: "x" }],
    ["no reason", { path: "/srv/project", access: "read", reason: "" }],
    ["an overlong reason", { path: "/srv/project", access: "read", reason: "x".repeat(301) }],
    ["an overlong path", { path: `/${"a".repeat(1100)}`, access: "read", reason: "x" }],
  ])("rejects %s", (_what, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });

  it("refuses on a turn that is not sandboxed, and on one no single group owns", async () => {
    const h = harness();
    const [owner] = buildPermissionTools({ broker: h.broker, sessionKey: "dm:owner", scope: () => ({ refusal: PERMISSION_NOT_SANDBOXED }) });
    const r = await (owner as unknown as { handler: (a: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> })
      .handler({ path: fx.external, access: "read", reason: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("not sandboxed");
    expect(h.broker.views()).toEqual([]);
  });

  it("refuses a path that cannot be resolved, or that is never granted, without asking", async () => {
    const h = harness();
    expect((await h.broker.request({ sessionKey: GROUP, groupKey: GROUP, path: "/srv/../etc", access: "read", reason: "x" })).status).toBe("denied");
    for (const path of [PRIVATE, CONFIG, join(fx.ws, "secrets"), "/", "~"]) {
      const r = await h.broker.request({ sessionKey: GROUP, groupKey: GROUP, path, access: "read", reason: "x" });
      expect(r.status, path).toBe("denied");
    }
    const scene = await h.broker.request({ sessionKey: GROUP, groupKey: GROUP, path: join(fx.ws, "home"), access: "write", reason: "x" });
    expect(scene.status).toBe("denied");
    expect(h.dm.sent).toEqual([]);
  });

  it("answers already_allowed for what the group can already reach", async () => {
    const h = harness();
    expect(await h.broker.request({ sessionKey: GROUP, groupKey: GROUP, path: join(fx.ws, "notes"), access: "write", reason: "x" }))
      .toMatchObject({ status: "already_allowed" });
  });
});

describe("who an Allow once reaches", () => {
  it("not a subagent's call, only the main agent's", async () => {
    const h = harness();
    const { id } = await ask(h);
    h.broker.decide(id, "once", "web");
    const answer = h.answerTurn();
    const sub = await guard(h.broker)({ tool_name: "Read", tool_input: { file_path: EXTERNAL }, agent_id: "agent-1" });
    expect(sub.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(await readAllowed(h.broker)).toBe(true);
    h.turns.end(GROUP, answer);
  });

  it("never a Bash profile, foreground or background, main agent or not; the file tools do get it", async () => {
    const h = harness();
    const { id } = await ask(h, fx.external, "write");
    h.broker.decide(id, "once", "web");
    const answer = h.answerTurn();
    const grantLine = `(subpath "${fx.external}")`;
    for (const tool_input of [{ command: "true" }, { command: "setsid sleep 600 &", run_in_background: true }]) {
      const r = await guard(h.broker)({ tool_name: "Bash", tool_input });
      expect(r.hookSpecificOutput?.updatedInput?.command).toBeDefined();
      expect(r.hookSpecificOutput?.updatedInput?.command).not.toContain(grantLine);
    }
    expect(await readAllowed(h.broker)).toBe(true);
    const write = await guard(h.broker)({ tool_name: "Write", tool_input: { file_path: join(fx.external, "new.txt"), content: "x" } });
    expect(write.hookSpecificOutput?.permissionDecision).not.toBe("deny");
    h.turns.end(GROUP, answer);
  });

  it("an Always allow reaches both (it is config)", async () => {
    const h = harness();
    const { id } = await ask(h);
    h.broker.decide(id, "always", "web");
    const bg = await guard(h.broker)({ tool_name: "Bash", tool_input: { command: "true", run_in_background: true }, agent_id: "agent-1" });
    expect(bg.hookSpecificOutput?.updatedInput?.command).toContain(`(subpath "${fx.external}")`);
  });
});

describe("asking the owner", () => {
  it("DMs four lines with a code and opens a card with the resolved path", async () => {
    const h = harness();
    await guard(h.broker)({ tool_name: "Bash", tool_input: { command: `cat ${EXTERNAL}` } });
    const pending = await ask(h);
    expect(pending.code).toMatch(/^[A-HJ-NP-Z][2-9][A-HJ-NP-Z]$/);
    expect(h.dm.sent).toHaveLength(1);
    const lines = h.dm.sent[0].text.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain(`Permission request ${pending.code}`);
    expect(lines[1]).toBe(`Weekend project · ${fx.external}`);
    expect(lines[2]).toContain("not verified");
    expect(lines[3]).toContain(`"1 ${pending.code}"`);
    const view = h.broker.views()[0];
    expect(view).toMatchObject({ group: "Weekend project", path: fx.external, access: "read", command: `cat ${EXTERNAL}` });
    expect(h.cards.at(-1)).toEqual([view]);
    const ledger = readFileSync(LEDGER, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(ledger.at(-1)).toMatchObject({ event: "requested", code: pending.code, path: fx.external, access: "read" });
  });

  it("allows one open request per group", async () => {
    const h = harness();
    await ask(h);
    const second = await h.broker.request({ sessionKey: GROUP, groupKey: GROUP, path: join(fx.root, "elsewhere"), access: "read", reason: "x" });
    expect(second).toMatchObject({ status: "denied" });
    expect((second as { reason: string }).reason).toContain("already has a request open");
    const other = await h.broker.request({ sessionKey: OTHER_GROUP, groupKey: OTHER_GROUP, path: fx.external, access: "read", reason: "x" });
    expect(other.status).toBe("pending");
    expect(h.broker.views()).toHaveLength(2);
  });
});

describe("the three answers", () => {
  it("Allow once applies in the turn that carries the answer, and in no other", async () => {
    const h = harness();
    const asking = h.turns.begin(GROUP, [GROUP]);
    const { id } = await ask(h);
    expect(await readAllowed(h.broker)).toBe(false);
    expect(h.broker.decide(id, "once", "web")).toEqual({ ok: true, outcome: "allowed_once" });
    // The asking turn, still running when the owner answered, does not get it.
    expect(await readAllowed(h.broker)).toBe(false);
    expect(h.notes.at(-1)).toMatchObject({ sessionKey: GROUP, outcome: "allowed_once" });
    h.turns.end(GROUP, asking);
    const answer = h.answerTurn();
    expect(await readAllowed(h.broker)).toBe(true);
    h.turns.end(GROUP, answer);
    const later = h.turns.begin(GROUP, [GROUP]);
    expect(await readAllowed(h.broker)).toBe(false);
    h.turns.end(GROUP, later);
    expect(live.config.groupSandbox.groups[GROUP]).toBeUndefined();
    expect(JSON.parse(readFileSync(CONFIG, "utf8")).groupSandbox.groups).toEqual({});
  });

  it("Allow once is not usable while another turn runs beside the answer turn", async () => {
    const h = harness();
    const { id } = await ask(h);
    h.broker.decide(id, "once", "web");
    const answer = h.answerTurn();
    const concurrent = h.turns.begin(GROUP, [GROUP]);
    expect(await readAllowed(h.broker)).toBe(false);
    h.turns.end(GROUP, concurrent);
    expect(await readAllowed(h.broker)).toBe(true);
    h.turns.end(GROUP, answer);
  });

  it("Allow once does not pass to the next turn, even if the answer turn never used it", async () => {
    const h = harness();
    const { id } = await ask(h);
    h.broker.decide(id, "once", "web");
    const unrelated = h.turns.begin(GROUP, [GROUP]); // begun after the answer, but not the answer's turn
    expect(await readAllowed(h.broker)).toBe(false);
    h.turns.end(GROUP, unrelated);
    h.turns.end(GROUP, h.answerTurn()); // the answer turn: no file call at all
    const later = h.turns.begin(GROUP, [GROUP]);
    expect(await readAllowed(h.broker)).toBe(false);
    h.turns.end(GROUP, later);
  });

  it("Allow once does not reach a turn of another group running at the same time", async () => {
    const h = harness();
    const other = h.turns.begin(OTHER_GROUP, [OTHER_GROUP]);
    const { id } = await ask(h);
    h.broker.decide(id, "once", "web");
    const answer = h.answerTurn();
    const otherGuard = privateMemoryGuardHooks(OTHER_GROUP, () => "group-session", () => [], (opts) => sandboxFor(h.broker, OTHER_GROUP, opts), () => OTHER_GROUP)
      .PreToolUse[0].hooks[0] as (input: { tool_name: string; tool_input: unknown }) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;
    expect((await otherGuard({ tool_name: "Read", tool_input: { file_path: EXTERNAL } })).hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(await readAllowed(h.broker)).toBe(true);
    h.turns.end(GROUP, answer); h.turns.end(OTHER_GROUP, other);
  });

  it("Always allow is written to config (with a backup) and the next call's profile includes it", async () => {
    const h = harness();
    const before = readFileSync(CONFIG, "utf8");
    const { id } = await ask(h, fx.external, "write");
    const decided = h.broker.decide(id, "always", "web") as { ok: true; outcome: string; grantId: string };
    expect(decided).toMatchObject({ ok: true, outcome: "allowed_always", grantId: expect.stringMatching(/^G-[A-HJ-NP-Z2-9]{6}$/) });
    const written = JSON.parse(readFileSync(CONFIG, "utf8"));
    expect(written.model).toBe("x");
    expect(written.groupSandbox.groups[GROUP]).toEqual({ extraRead: [], extraWrite: [fx.external], unsandboxed: false,
      grants: { [decided.grantId]: { path: fx.external, access: "write", requestId: id } } });
    expect(readFileSync(BACKUP, "utf8")).toBe(before);
    expect(live.config.groupSandbox.groups[GROUP].extraWrite).toEqual([fx.external]);
    const r = await guard(h.broker)({ tool_name: "Bash", tool_input: { command: "true" } });
    expect(r.hookSpecificOutput?.updatedInput?.command).toContain(`(allow file-read* file-write* (subpath "${fx.external}"))`);
    expect(await readAllowed(h.broker)).toBe(true);
    expect(h.notes.at(-1)?.outcome).toBe("allowed_always");
  });

  it("Always allow keeps a legacy allowlisted group unsandboxed", () => {
    live.config.groupShellAllowlist = [GROUP];
    writeFileSync(CONFIG, JSON.stringify({ groupShellAllowlist: [GROUP] }));
    expect(persistGroupGrant(GROUP, "read", fx.external, { configPath: CONFIG, backupPath: BACKUP, live: live.config })).toBe(true);
    expect(JSON.parse(readFileSync(CONFIG, "utf8")).groupSandbox.groups[GROUP].unsandboxed).toBe(true);
    expect(live.config.groupSandbox.groups[GROUP].unsandboxed).toBe(true);
  });

  it("Deny grants nothing", async () => {
    const h = harness();
    const turn = h.turns.begin(GROUP, [GROUP]);
    const { id } = await ask(h);
    expect(h.broker.decide(id, "deny", "web")).toEqual({ ok: true, outcome: "denied" });
    expect(await readAllowed(h.broker)).toBe(false);
    expect(h.notes.at(-1)?.outcome).toBe("denied");
    expect(h.broker.views()).toEqual([]);
    expect(h.broker.decide(id, "once", "web")).toMatchObject({ ok: false, status: 410 });
    h.turns.end(GROUP, turn);
  });

  it("a request nobody answers times out as a denial", async () => {
    vi.useFakeTimers();
    const h = harness({ timeoutMs: 60_000 });
    const turn = h.turns.begin(GROUP, [GROUP]);
    const { id, code } = await ask(h);
    vi.advanceTimersByTime(60_001);
    expect(h.notes.at(-1)?.outcome).toBe("timed_out");
    expect(h.broker.views()).toEqual([]);
    expect(h.cards.at(-1)).toEqual([]);
    expect(h.broker.decide(id, "once", "web")).toMatchObject({ ok: false, status: 410 });
    expect(await readAllowed(h.broker)).toBe(false);
    // A late reply is told, and goes no further.
    expect(await h.broker.handleInbound(h.dm as never, ownerDm(`1 ${code}`) as never)).toBe(true);
    expect(h.dm.sent.at(-1)?.text).toContain("no longer open");
    expect(await readAllowed(h.broker)).toBe(false);
    h.turns.end(GROUP, turn);
  });

  it("revoking an Always allow takes effect on the next call", async () => {
    const h = harness();
    const { id } = await ask(h);
    h.broker.decide(id, "always", "web");
    expect(await readAllowed(h.broker)).toBe(true);
    expect(h.broker.revoke(GROUP, fx.external)).toBe(true);
    expect(await readAllowed(h.broker)).toBe(false);
    expect(JSON.parse(readFileSync(CONFIG, "utf8")).groupSandbox.groups[GROUP].extraRead).toEqual([]);
    expect(readFileSync(LEDGER, "utf8")).toContain('"event":"revoked"');
  });
});

describe("revoking, and a restart", () => {
  it("Always allow gets a durable grant id, shown in the DM, and `revoke <grant id>` takes it back (the owner's DM only)", async () => {
    const h = harness();
    const { code } = await ask(h);
    expect(await h.broker.handleInbound(h.dm as never, ownerDm(`2 ${code}`) as never)).toBe(true);
    const grantId = /revoke (G-[A-Z0-9]{6})/.exec(h.dm.sent.at(-1)!.text)![1];
    const stored = JSON.parse(readFileSync(CONFIG, "utf8")).groupSandbox.groups[GROUP];
    expect(stored.grants[grantId]).toMatchObject({ path: fx.external, access: "read" });
    expect(await readAllowed(h.broker)).toBe(true);
    const groupMessage = { ...ownerDm(`revoke ${grantId}`), chatId: "-100777", isGroup: true };
    expect(await h.broker.handleInbound(chatChannel() as never, groupMessage as never)).toBe(false);
    expect(await h.broker.handleInbound(h.dm as never, { ...ownerDm(`revoke ${grantId}`), senderId: "9999" } as never)).toBe(false);
    // The request code is not a revoke handle.
    expect(await h.broker.handleInbound(h.dm as never, ownerDm(`revoke ${code}`) as never)).toBe(false);
    expect(await readAllowed(h.broker)).toBe(true);
    expect(await h.broker.handleInbound(h.dm as never, ownerDm(`revoke ${grantId.toLowerCase()}`) as never)).toBe(true);
    expect(h.dm.sent.at(-1)?.text).toContain(`Revoked ${grantId}`);
    expect(await readAllowed(h.broker)).toBe(false);
    const after = JSON.parse(readFileSync(CONFIG, "utf8")).groupSandbox.groups[GROUP];
    expect(after.extraRead).toEqual([]);
    expect(after.grants).toEqual({});
    expect(readFileSync(LEDGER, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1)).toMatchObject({ event: "revoked", groupKey: GROUP, grantId, via: "telegram" });
  });

  it("a grant id names exactly one grant, even when request codes repeat", async () => {
    const h = harness();
    const first = await ask(h);
    const a = h.broker.decide(first.id, "always", "web") as { grantId: string };
    const other = await h.broker.request({ sessionKey: OTHER_GROUP, groupKey: OTHER_GROUP, path: fx.external, access: "read", reason: "x" });
    const b = h.broker.decide((other as { id: string }).id, "always", "web") as { grantId: string };
    expect(a.grantId).not.toBe(b.grantId);
    // Pretend both requests had the same code (codes are short and may repeat across restarts): revoke still hits one.
    expect(h.broker.revokeGrant(b.grantId, "web")).toMatchObject({ groupKey: OTHER_GROUP, ok: true });
    expect(live.config.groupSandbox.groups[GROUP].extraRead).toEqual([fx.external]);
    expect(live.config.groupSandbox.groups[OTHER_GROUP].extraRead).toEqual([]);
    expect(h.broker.revokeGrant("G-ZZZZZZ", "web")).toBeNull();
    expect(await h.broker.handleInbound(h.dm as never, ownerDm("revoke G-ZZZZZZ") as never)).toBe(true);
    expect(h.dm.sent.at(-1)?.text).toContain("nothing was revoked");
  });

  it("an Always allow saved to config before a crash is recovered as allowed, not denied", async () => {
    rmSync(LEDGER, { force: true });
    const before = harness();
    const { id } = await ask(before);
    // The config write happened; the process died before the ledger line.
    expect(persistGroupGrant(GROUP, "read", fx.external, { configPath: CONFIG, backupPath: BACKUP, live: live.config }, { id: "G-ABCDEF", requestId: id })).toBe(true);
    before.broker.shutdown();
    const after = harness();
    expect(after.broker.reconcileAfterRestart()).toBe(1);
    expect(after.notes).toMatchObject([{ sessionKey: GROUP, outcome: "allowed_always" }]);
    const ledger = readFileSync(LEDGER, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(ledger.at(-1)).toMatchObject({ event: "decided", id, outcome: "allowed_always", grantId: "G-ABCDEF", reason: "recovered_after_restart" });
    expect(await readAllowed(after.broker)).toBe(true);
  });

  it("a request the last run left open is recorded as denied (restart), its session told, and a late reply closed", async () => {
    rmSync(LEDGER, { force: true });
    const before = harness();
    const { code } = await ask(before);
    before.broker.shutdown(); // the process dies with the request open
    const after = harness();
    expect(after.broker.reconcileAfterRestart()).toBe(1);
    expect(after.notes).toMatchObject([{ sessionKey: GROUP, outcome: "denied" }]);
    expect(after.notes[0].body).toContain("restarted");
    expect(after.cards.at(-1)).toEqual([]);
    const ledger = readFileSync(LEDGER, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(ledger.at(-1)).toMatchObject({ event: "decided", code, outcome: "denied", reason: "restart" });
    expect(await after.broker.handleInbound(after.dm as never, ownerDm(`1 ${code}`) as never)).toBe(true);
    expect(after.dm.sent.at(-1)?.text).toContain("no longer open");
    // Once is enough: a second start finds nothing left open.
    expect(harness().broker.reconcileAfterRestart()).toBe(0);
    // And the group may ask again.
    expect((await after.broker.request({ sessionKey: GROUP, groupKey: GROUP, path: fx.external, access: "read", reason: "x" })).status).toBe("pending");
  });
});

describe("who can answer", () => {
  it("the owner's DM reply with the code counts, either order", async () => {
    const h = harness();
    const { code } = await ask(h);
    expect(await h.broker.handleInbound(h.dm as never, ownerDm(`${code.toLowerCase()} 3`) as never)).toBe(true);
    expect(h.notes.at(-1)?.outcome).toBe("denied");
    expect(h.dm.sent.at(-1)?.text).toBe(`Denied (${code}).`);
  });

  it("a quoted reply to the request counts", async () => {
    const h = harness();
    const turn = h.turns.begin(GROUP, [GROUP]);
    await ask(h);
    const requestMessage = h.dm.sent[0];
    expect(await h.broker.handleInbound(h.dm as never, ownerDm("1", { replyToId: requestMessage.id, text: `[replying to: "…"] 1` }) as never)).toBe(true);
    expect(h.notes.at(-1)?.outcome).toBe("allowed_once");
    h.turns.end(GROUP, turn);
    const answer = h.answerTurn();
    expect(await readAllowed(h.broker)).toBe(true);
    h.turns.end(GROUP, answer);
  });

  it("a bare reply in the DM does not count and reaches the model as an ordinary message", async () => {
    const h = harness();
    await ask(h);
    for (const text of ["1", "2", "yes", "allow", "1 please"]) {
      expect(await h.broker.handleInbound(h.dm as never, ownerDm(text) as never), text).toBe(false);
    }
    expect(h.broker.views()).toHaveLength(1);
    expect(h.notes).toEqual([]);
  });

  it("nothing said in a group counts, not even by the owner and not with the code", async () => {
    const h = harness();
    const { code, id } = await ask(h);
    const groupChat = chatChannel();
    for (const senderId of ["9999", OWNER_ID]) {
      const message = { ...ownerDm(`1 ${code}`), chatId: "-100777", senderId, isGroup: true };
      expect(await h.broker.handleInbound(groupChat as never, message as never)).toBe(false);
    }
    // A non-owner's private chat does not count either.
    expect(await h.broker.handleInbound(h.dm as never, { ...ownerDm(`1 ${code}`), senderId: "9999" } as never)).toBe(false);
    expect(h.broker.views().map((v) => v.id)).toEqual([id]);
    expect(h.notes).toEqual([]);
  });

  it("the DM text names the code on its first line (the quoted-reply match relies on it)", () => {
    const text = permissionDmText({ id: "x", code: "K7Q", group: "G", path: "/p", access: "write", reason: "r", expiresAt: 0 }, 5);
    expect(text.split("\n")[0]).toBe("Permission request K7Q: a group wants to read and write a path.");
  });
});

// ---------------------------------------------------------------------------
// The kernel: the grant reaches the sandbox profile of the next Bash call.
// ---------------------------------------------------------------------------

const sandboxRuns = process.platform === "darwin" && existsSync(SANDBOX_EXEC_PATH) && existsSync(SANDBOX_SHELL_PATH);

describe.runIf(sandboxRuns)("under a real sandbox-exec", () => {
  async function cat(broker: Broker) {
    const r = await guard(broker)({ tool_name: "Bash", tool_input: { command: `cat ${shellSingleQuote(EXTERNAL)}` } });
    const wrapped = r.hookSpecificOutput?.updatedInput?.command;
    expect(typeof wrapped).toBe("string");
    const run = spawnSync("/bin/zsh", ["-lc", wrapped!], { encoding: "utf8", cwd: fx.ws });
    return { code: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
  }

  it("after Allow once the shell still cannot read the target, while Read can (in the answer turn only)", async () => {
    const h = harness();
    const turn = h.turns.begin(GROUP, [GROUP]);
    expect((await cat(h.broker)).out).not.toContain("EXTERNAL-CONTENT");
    const { id } = await ask(h);
    h.broker.decide(id, "once", "web");
    h.turns.end(GROUP, turn);
    const answer = h.answerTurn();
    const shell = await cat(h.broker);
    expect(shell.code).not.toBe(0);
    expect(shell.out).not.toContain("EXTERNAL-CONTENT");
    expect(await readAllowed(h.broker)).toBe(true);
    h.turns.end(GROUP, answer);
    const later = h.turns.begin(GROUP, [GROUP]);
    expect(await readAllowed(h.broker)).toBe(false);
    h.turns.end(GROUP, later);
  });

  it("after Always allow the target is readable; after revoke it is not", async () => {
    const h = harness();
    const { id } = await ask(h);
    h.broker.decide(id, "always", "web");
    expect(await cat(h.broker)).toMatchObject({ code: 0, out: "EXTERNAL-CONTENT\n" });
    h.broker.revoke(GROUP, fx.external);
    const after = await cat(h.broker);
    expect(after.code).not.toBe(0);
    expect(after.out).not.toContain("EXTERNAL-CONTENT");
  });
});
