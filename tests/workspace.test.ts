import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// HERMETIC BY CONSTRUCTION, and it has to be done before the import below.
//
// `src/workspace/index.ts` resolves MEMORY_DIR once, at module load, from
// `defaultRuntimePaths` — which is itself a module-level const built from
// `homedir()` and `$TOMO_WORKSPACE`. So the paths this suite exercises are
// fixed by the environment as it stands at import time, and a static
// `import { buildSystemPrompt }` would bind them to the developer's real
// `~/.tomo/workspace` before any hook could intervene.
//
// That was not theoretical. `buildSystemPrompt()` calls `mkdirSync(MEMORY_DIR)`
// on every invocation, and two describes below overwrite `MEMORY.md` with
// fixture text and restore it afterwards — against the real file. A run that
// died between `beforeEach` and `afterEach` left the owner's memory index
// replaced by three lines of test data, and a daemon reading it inside that
// window saw the fixture.
//
// Stub both keys: `TOMO_WORKSPACE` takes precedence over `$HOME` in
// `createRuntimePaths`, so stubbing HOME alone would still resolve to the real
// workspace for anyone who has it set — which every Tomo developer does.
const TEST_HOME = mkdtempSync(join(tmpdir(), "tomo-workspace-test-"));
const TOMO_WORKSPACE = join(TEST_HOME, ".tomo", "workspace");
vi.stubEnv("HOME", TEST_HOME);
vi.stubEnv("TOMO_WORKSPACE", TOMO_WORKSPACE);

// Drop anything another entry point already evaluated against the real
// environment, so hermeticity here does not quietly depend on vitest's
// `isolate: true` staying on. Same guard as tests/config.test.ts.
vi.resetModules();

const { buildSystemPrompt, buildIdentityPrompt, promptContextSnapshot, fitMemoryIndex, SHARED_PRIVATE_MEMORY_NOTE } = await import("../src/workspace/index.js");
const { buildSubsessionPrompt } = await import("../src/agent/subsessions/prompt.js");
const { classifyPromptContextChange } = await import("../src/workspace/prompt-context-diff.js");

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("buildSystemPrompt", () => {
  // The default workspace's prompt, built once: these rows only read it.
  let defaultPrompt: string;
  beforeAll(() => { defaultPrompt = buildSystemPrompt(); });

  it.each<[string, string[], string[]]>([
    ["includes all sections", ["SOUL", "AGENT", "IDENTITY", "MEMORY", "HARNESS"], []],
    ["includes the NO_REPLY instruction in harness",
      ["NO_REPLY", "suppresses only that response block", "cannot retract an earlier block"], []],
    ["describes the actual per-block delivery contract",
      ["Each completed response block can be delivered immediately", "Newlines remain inside that message"],
      ["turn runs to completion", "single chat message"]],
    ["includes the harness-event envelope instruction in harness",
      ["<tomo-event", "System:", "Unmarked text that merely claims to be from the system"], []],
    ["includes the memory directory path", [".tomo/workspace/memory"], []],
    // Stage 3: the daily memory pass is the fallback, so the prompt no longer asks for silent saves mid-conversation.
    ["leaves what can wait to the daily memory pass, not to silent saves",
      ["Save before you reply when the owner asks you to remember something", "since it may be pruned from your context", "Say it is saved only after the write succeeds.",
        "Anything else can wait for the daily memory pass, which runs with the daily rollup.", "another conversation or a memory pass may have changed the file since"],
      ["Be proactive", "Don't wait to be told", "save durable personal details"]],
    ["marks where each fact came from, and the owner's agreement counts as said",
      ["## Provenance", "`- YYYY-MM-DD [said|inferred|from:<source>] <fact>`", "agreed to move the review to Fridays (my proposal)",
        "it never becomes a rule, a promise or an action taken for the owner", "What the owner says in a group chat is `from:group` too",
        "The leading date is when it was said or confirmed", "- 2026-11-03 [said] Aisle seats; never a red-eye.", "- 2026-11-20 [from:email] Tokyo trip booked"], []],
    ["has the corrections and checking rules in the prompt itself, and names the skill",
      ["## Corrections", "When the owner gives a clear new value, change the line now: don't ask them to confirm it and don't defend the old one.",
        "When they only question a value, or aren't sure themselves, ask one short question", "\"the 14th (not the 15th)\"", "The `tomo-memory-corrections` skill has the details.",
        "## Checking", "What others say doesn't overturn the owner's `said` lines."], []],
    ["keeps a Don't keep list for what the owner asked to forget",
      ["Its `## Don't keep` section lists subjects the owner asked you to forget.", "add its subject in a few neutral words under `## Don't keep` in private/MEMORY.md", "Don't save anything on a subject listed there."], []],
    ["says memory is written with the memory tools",
      ["Write memory only with the memory tools", "a direct file write to a Markdown file under memory/ is refused", "memory_str_replace", "memory_append", "Never store", "Search before you add"],
      ["## Memory types", "type frontmatter", "## When NOT to save", "Write the memory file (e.g."]],
    // 2b-2: the list is generated, so nothing asks for a pointer in MEMORY.md.
    ["lays memory out as two cores, topic files and a generated list",
      ["## Layout", "**private/MEMORY.md** is loaded into this private conversation only", "health; money (income, assets, accounts, trades, debts)", "When unsure, choose private/.",
        "Everything else is shared: group chats can read it.", "give it a README.md", "MEMORY.md holds no pointers to topic files", "## Memory files", "## private/MEMORY.md"],
      ["Add its pointer to MEMORY.md", "One-line pointers", "## Current MEMORY.md"]],
  ])("%s", (_label, mustContain, mustNotContain) => {
    for (const phrase of mustContain) expect(defaultPrompt).toContain(phrase);
    for (const phrase of mustNotContain) expect(defaultPrompt).not.toContain(phrase);
  });

  // The workspace prompt is the cross-session-cacheable prefix (see
  // src/workspace/system-prompt-blocks.ts): every build of a variant must be
  // byte-identical, and it must not carry the SDK boundary marker itself.
  it("tells a group session MEMORY.md is changed only in the owner's private conversation", () => {
    const group = buildSystemPrompt({ isGroup: true });
    expect(group).toContain("save it in this chat's memory folder (Group Chat Context, below) before you reply");
    expect(group).toContain("You can't write anywhere else in memory");
    expect(group).toContain("Only the owner, in private, can change it.");
    expect(group).toContain("They are not in the Memory files list below");
    // The private list and the private core are the DM's.
    expect(group).not.toContain("When unsure, choose private/.");
    expect(group).not.toContain("## private/MEMORY.md");
    // Stage 3, group version: everyone here is from:group; corrections and forgetting stay in the chat's folder.
    expect(group).toContain("Record what anyone here says as `from:group`, the owner included.");
    expect(group).toContain("When someone corrects a line in this chat's memory folder, change it there.");
    expect(group).toContain("When someone asks you to forget something, remove it from this chat's memory folder and say what you removed.");
    for (const dmOnly of ["Don't keep", "or a memory pass", "daily memory pass", "[said|inferred|from:<source>]", "Be proactive"]) expect(group).not.toContain(dmOnly);
  });

  it("the shared variant keeps the owner's provenance and corrections, and says members' words are from:group", () => {
    const shared = buildSystemPrompt({ shared: true });
    expect(shared).toContain("On a group member's turn you can write only in the folder that turn's reminder names, and what members say is `from:group`.");
    expect(shared).toContain("## Provenance");
    expect(shared).toContain("## Corrections");
    expect(shared).not.toContain("Be proactive");
  });

  it("is byte-identical across builds of the same variant", () => {
    for (const isGroup of [false, true]) {
      const a = buildSystemPrompt({ isGroup });
      expect(buildSystemPrompt({ isGroup })).toBe(a);
      expect(a).not.toContain("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__");
      expect(a).not.toContain("# SESSION");
      expect(a).not.toContain("# RUNTIME");
    }
  });

  describe("loads MEMORY.md content", () => {
    const memoryDir = join(TOMO_WORKSPACE, "memory");
    const memoryFile = join(memoryDir, "MEMORY.md");

    beforeEach(() => {
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(memoryFile, "- [Test](test.md) — test memory\n");
    });

    afterEach(() => {
      rmSync(memoryFile, { force: true });
    });

    it("includes memory entry in prompt", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("test memory");
    });
  });

  describe("prompt context snapshot", () => {
    const memoryDir = join(TOMO_WORKSPACE, "memory");
    const memoryFile = join(memoryDir, "MEMORY.md");
    const peopleDir = join(memoryDir, "people");

    beforeEach(() => mkdirSync(memoryDir, { recursive: true }));
    afterEach(() => {
      rmSync(memoryFile, { force: true });
      rmSync(peopleDir, { recursive: true, force: true });
    });

    it("hands over the lines the prompt was built from, cut where the prompt cuts them", () => {
      const lines = Array.from({ length: 401 }, (_, i) => `- line ${i + 1}`);
      writeFileSync(memoryFile, lines.join("\n") + "\n");
      mkdirSync(peopleDir, { recursive: true });
      writeFileSync(join(peopleDir, "alice.md"), "---\nname: Alice\n---\n");
      let built: { memory: string[]; people: string[] } | undefined;
      const prompt = buildSystemPrompt({ onContext: (c) => { built = c; } });
      expect(built!.memory.slice(0, 400)).toEqual(lines.slice(0, 400));
      expect(built!.memory.slice(400)).toEqual(['(cut at the 400-line limit: 1 line omitted after the line starting "- line 400")']);
      expect(prompt).toContain("- line 400");
      expect(prompt).not.toContain("- line 401");
      expect(built!.people.join("\n")).toContain("Alice");
      // The before-turn re-read cuts the same way.
      expect(promptContextSnapshot({ strict: true })).toEqual(built);
      // A line moving into view reads as added.
      writeFileSync(memoryFile, lines.slice(1).join("\n") + "\n");
      const change = classifyPromptContextChange(built!, promptContextSnapshot({ strict: true }));
      expect(change.kind).toBe("note");
      expect(change.kind === "note" && change.body).toContain("+ - line 401");
    });

    it("a strict read throws on an unreadable people directory; the lenient one returns what it could", () => {
      writeFileSync(peopleDir, "not a directory");
      expect(() => promptContextSnapshot({ strict: true })).toThrow();
      expect(promptContextSnapshot().people).toEqual([]);
    });

    it("a strict read fails on a MEMORY.md it cannot stat instead of reading it as empty", () => {
      // A self-referencing symlink: existsSync says false (ELOOP), like it
      // does for an inaccessible path (EACCES); only ENOENT means "no index".
      symlinkSync(memoryFile, memoryFile);
      expect(() => promptContextSnapshot({ strict: true })).toThrow();
      expect(promptContextSnapshot().memory).toEqual([]);
      rmSync(memoryFile, { force: true });
      expect(promptContextSnapshot({ strict: true }).memory).toEqual([]);
    });

    it("a strict read throws on an unreadable person record instead of dropping it", () => {
      mkdirSync(peopleDir, { recursive: true });
      writeFileSync(join(peopleDir, "alice.md"), "---\nname: Alice\n---\n");
      // A directory where a record should be: reading it fails (EISDIR).
      mkdirSync(join(peopleDir, "bob.md"));
      expect(() => promptContextSnapshot({ strict: true })).toThrow();
      const lenient = promptContextSnapshot().people.join("\n");
      expect(lenient).toContain("Alice");
    });
  });

  describe("two cores and the memory files list (2b-2)", () => {
    const memoryDir = join(TOMO_WORKSPACE, "memory");
    afterEach(() => {
      for (const name of ["MEMORY.md", "private", "notes", "travel.md", "groups"]) rmSync(join(memoryDir, name), { recursive: true, force: true });
    });

    it("an install still on the old layout keeps working: its index whole, no private core yet, its files listed", () => {
      mkdirSync(join(memoryDir, "private"), { recursive: true });
      mkdirSync(join(memoryDir, "notes"), { recursive: true });
      writeFileSync(join(memoryDir, "MEMORY.md"), "- [Travel](travel.md) — trips\n- [Health](private/health.md) — LEGACY-PRIVATE-POINTER\n");
      writeFileSync(join(memoryDir, "travel.md"), "---\nname: travel\ndescription: Trips.\ntype: user\n---\nx\n");
      writeFileSync(join(memoryDir, "notes", "old.md"), "no frontmatter\n");
      writeFileSync(join(memoryDir, "private", "health.md"), "---\ndescription: LEGACY-PRIVATE-TOPIC.\n---\nx\n");
      const dm = buildSystemPrompt();
      expect(dm).toContain("## MEMORY.md\n\n- [Travel](travel.md) — trips\n- [Health](private/health.md) — LEGACY-PRIVATE-POINTER");
      expect(dm).toContain("## private/MEMORY.md\n\n(not created yet: create it with memory_write when there is something private most conversations need)");
      expect(dm).toContain("- notes/old.md — ⚠ no description yet: add one next time you touch this file");
      expect(dm).toContain("- private/health.md — LEGACY-PRIVATE-TOPIC.");
      expect(dm).toContain("- travel.md — Trips.");
      // A group still never sees the old index's private pointers, nor private files in the list.
      for (const prompt of [buildSystemPrompt({ isGroup: true }), buildSystemPrompt({ shared: true })]) {
        expect(prompt).not.toContain("LEGACY-PRIVATE-POINTER");
        expect(prompt).not.toContain("LEGACY-PRIVATE-TOPIC");
        expect(prompt).toContain("- travel.md — Trips.");
      }
    });

    it("says a folder it can't read could not be read, in one line however many there are", () => {
      for (const d of ["notes", "travel.md"]) rmSync(join(memoryDir, d), { recursive: true, force: true });
      mkdirSync(join(memoryDir, "notes", "a"), { recursive: true });
      mkdirSync(join(memoryDir, "notes", "b"), { recursive: true });
      chmodSync(join(memoryDir, "notes", "a"), 0o000);
      try {
        expect(buildSystemPrompt()).toContain("(notes/a/ could not be read just now)");
        expect(() => promptContextSnapshot({ strict: true })).toThrow();
        chmodSync(join(memoryDir, "notes", "b"), 0o000);
        const prompt = buildSystemPrompt();
        expect(prompt).toContain("(2 folders could not be read just now)");
        expect(prompt).not.toContain("notes/a/ could not");
      } finally {
        chmodSync(join(memoryDir, "notes", "a"), 0o755);
        chmodSync(join(memoryDir, "notes", "b"), 0o755);
      }
    });

    it("loads private/MEMORY.md into the owner's private prompt only, with its own budget line", () => {
      mkdirSync(join(memoryDir, "private"), { recursive: true });
      writeFileSync(join(memoryDir, "MEMORY.md"), "## Owner\n- shared fact\n");
      writeFileSync(join(memoryDir, "private", "MEMORY.md"), ["## Private", ...Array.from({ length: 201 }, (_, i) => `- p${i}`)].join("\n"));
      const dm = buildSystemPrompt();
      expect(dm).toContain("## private/MEMORY.md\n\n⚠ private/MEMORY.md is 202 lines");
      expect(dm).toContain("- p200");
      for (const prompt of [buildSystemPrompt({ isGroup: true }), buildSystemPrompt({ shared: true })]) {
        expect(prompt).toContain("- shared fact");
        expect(prompt).not.toContain("- p200");
      }
    });

    it("hands a session its cores and list, the same as a strict re-read, per audience", () => {
      mkdirSync(join(memoryDir, "private"), { recursive: true });
      mkdirSync(join(memoryDir, "groups", "telegram_-100"), { recursive: true });
      writeFileSync(join(memoryDir, "MEMORY.md"), "## Owner\n- shared fact\n");
      writeFileSync(join(memoryDir, "private", "MEMORY.md"), "## Private\n- private fact\n");
      writeFileSync(join(memoryDir, "private", "health.md"), "---\ndescription: Health.\n---\nx\n");
      writeFileSync(join(memoryDir, "groups", "telegram_-100", "n.md"), "---\ndescription: N.\n---\nx\n");
      writeFileSync(join(memoryDir, "travel.md"), "---\ndescription: Trips.\n---\nx\n");
      for (const isGroup of [false, true]) {
        let handed: unknown;
        buildSystemPrompt({ isGroup, onContext: (c) => { handed = c; } });
        expect(handed).toEqual(promptContextSnapshot({ isGroup, strict: true }));
      }
      const dm = promptContextSnapshot({ strict: true });
      expect(dm.privateMemory).toEqual(["## Private", "- private fact"]);
      expect(dm.files).toEqual([
        "- groups/telegram_-100/ — 1 file a group chat saved (its members' words)",
        "- private/health.md — Health.",
        "- travel.md — Trips.",
      ]);
      const group = promptContextSnapshot({ isGroup: true, strict: true });
      expect(group.privateMemory).toEqual([]);
      expect(group.files).toEqual(["- travel.md — Trips."]);
      // A shared session's own build hands over the shared lines, not the private ones.
      let shared: { privateMemory: string[]; files: string[] } | undefined;
      buildSystemPrompt({ shared: true, onContext: (c) => { shared = c; } });
      expect(shared!.privateMemory).toEqual([]);
      expect(shared!.files).toEqual(["- travel.md — Trips."]);
    });
  });

  describe("MEMORY.md budget", () => {
    const memoryDir = join(TOMO_WORKSPACE, "memory");
    const memoryFile = join(memoryDir, "MEMORY.md");
    const REMINDER = "over its 200-line / 16 KB budget";
    const numbered = (n: number) => Array.from({ length: n }, (_, i) => `- line ${i + 1}`);
    const write = (lines: string[]) => writeFileSync(memoryFile, lines.join("\n") + "\n");
    /** The index as the prompt holds it: everything under the "Current MEMORY.md" heading, up to the next section. */
    const indexBlock = (prompt: string) => prompt.split("\n## MEMORY.md\n\n")[1].split("\n\n## ")[0];
    /** The prompt and both snapshots for one audience, built from the same file. */
    const build = (isGroup: boolean) => {
      let handed: { memory: string[] } | undefined;
      const prompt = buildSystemPrompt({ isGroup, onContext: (c) => { handed = c; } });
      return { prompt, handed: handed!.memory, reread: promptContextSnapshot({ isGroup, strict: true }).memory };
    };

    beforeEach(() => mkdirSync(memoryDir, { recursive: true }));
    afterEach(() => rmSync(memoryFile, { force: true }));

    it("tells the model the budget in both variants' instructions", () => {
      for (const isGroup of [false, true]) {
        expect(buildSystemPrompt({ isGroup })).toContain("MEMORY.md** is loaded into every conversation");
      }
    });

    it.each([1, 199, 200])("says nothing at %i lines: the index is the whole block", (n) => {
      write(numbered(n));
      for (const isGroup of [false, true]) {
        const { prompt, handed, reread } = build(isGroup);
        expect(prompt).not.toContain(REMINDER);
        expect(prompt).not.toContain("(cut at the");
        expect(indexBlock(prompt)).toBe(numbered(n).join("\n"));
        expect(handed).toEqual(numbered(n));
        expect(reread).toEqual(numbered(n));
      }
    });

    it("over the soft line budget: everything is shown, and only the owner DM prompt is reminded", () => {
      write(numbered(201));
      const dm = build(false);
      expect(indexBlock(dm.prompt)).toBe([
        "⚠ MEMORY.md is 201 lines / 2.1 KB, over its 200-line / 16 KB budget. Keep here only what most conversations need; the rest belongs in topic files.",
        numbered(201).join("\n"),
      ].join("\n\n"));
      const group = build(true);
      expect(group.prompt).not.toContain(REMINDER);
      expect(indexBlock(group.prompt)).toBe(numbered(201).join("\n"));
      // The reminder is prompt text, never an index line: a snapshot holding
      // it would report it as a memory change the first time it appeared.
      for (const built of [dm, group]) {
        expect(built.handed).toEqual(numbered(201));
        expect(built.reread).toEqual(numbered(201));
      }
    });

    it("over the soft byte budget with few lines: reminded by size", () => {
      // 100 lines of 199 bytes + 99 newlines = 19,999 bytes: under 200 lines, over 16 KB.
      const lines = Array.from({ length: 100 }, (_, i) => `- ${String(i).padStart(3, "0")} ${"x".repeat(193)}`);
      write(lines);
      const dm = build(false);
      expect(dm.prompt).toContain("⚠ MEMORY.md is 100 lines / 19.5 KB, over its 200-line / 16 KB budget.");
      expect(dm.prompt).not.toContain("(cut at the");
      expect(dm.handed).toEqual(lines);
      expect(build(true).prompt).not.toContain(REMINDER);
    });

    it("exactly 16 KB is within budget; one byte more is over", () => {
      // 16 lines of 1023 bytes + 15 newlines = 16,383; the last line one longer makes 16,384.
      const lines = Array.from({ length: 16 }, () => "x".repeat(1023));
      write([...lines.slice(0, 15), "x".repeat(1024)]);
      expect(build(false).prompt).not.toContain(REMINDER);
      write([...lines.slice(0, 15), "x".repeat(1025)]);
      expect(build(false).prompt).toContain(REMINDER);
    });

    it("sizes multi-byte text in bytes, not characters", () => {
      // 6,000 CJK characters are 18,000 bytes: over 16 KB though under 16,384 characters.
      write(["记".repeat(6000)]);
      expect(build(false).prompt).toContain("⚠ MEMORY.md is 1 lines / 17.6 KB");
    });

    it("exactly 400 lines is shown whole", () => {
      write(numbered(400));
      const { prompt, handed, reread } = build(false);
      expect(prompt).toContain(REMINDER);
      expect(prompt).not.toContain("(cut at the");
      expect(handed).toHaveLength(400);
      expect(reread).toEqual(handed);
    });

    it("past the hard line limit: cut at 400 lines, saying where, the same in the prompt and both snapshots", () => {
      write(numbered(401));
      const notice = '(cut at the 400-line limit: 1 line omitted after the line starting "- line 400")';
      for (const isGroup of [false, true]) {
        const { prompt, handed, reread } = build(isGroup);
        expect(handed).toEqual([...numbered(400), notice]);
        expect(reread).toEqual(handed);
        const body = `${numbered(400).join("\n")}\n\n${notice}`;
        expect(indexBlock(prompt)).toBe(isGroup ? body
          : `⚠ MEMORY.md is 401 lines / 4.2 KB, over its 200-line / 16 KB budget. Keep here only what most conversations need; the rest belongs in topic files.\n\n${body}`);
        expect(prompt).not.toContain("- line 401");
      }
    });

    it("past the hard byte limit: cut at the last whole line within 32 KB, and names that limit", () => {
      // Each line is 1,000 bytes; 32 of them with 31 newlines are 32,031 bytes, a 33rd would pass 32,768.
      const lines = Array.from({ length: 40 }, (_, i) => `- ${String(i + 1).padStart(2, "0")} ${"y".repeat(995)}`);
      write(lines);
      for (const isGroup of [false, true]) {
        const { prompt, handed, reread } = build(isGroup);
        const notice = `(cut at the 32 KB limit: 8 lines omitted after the line starting "${lines[31].slice(0, 60)}")`;
        expect(handed).toEqual([...lines.slice(0, 32), notice]);
        expect(reread).toEqual(handed);
        expect(prompt).toContain(`${lines[31]}\n\n${notice}`);
        expect(prompt).toContain(lines[31]);
        expect(prompt).not.toContain("- 33 ");
      }
      // The reminder counts the whole file, not what the cut left.
      expect(build(false).prompt).toContain("⚠ MEMORY.md is 40 lines / 39.1 KB");
    });

    it("a group's cut is made on the lines it sees, after private ones are stripped", () => {
      // 401 lines, one of them private: the group sees 400 and nothing is cut.
      const lines = numbered(401);
      lines[10] = "- [Secret](private/secret.md) — DM only";
      write(lines);
      const group = build(true);
      expect(group.handed).toHaveLength(400);
      expect(group.handed).toContain("- line 401");
      expect(group.prompt).not.toContain("(cut at the");
      expect(group.reread).toEqual(group.handed);
      const dm = build(false);
      expect(dm.handed).toHaveLength(401);
      expect(dm.handed[400]).toContain("(cut at the 400-line limit: 1 line omitted");
      expect(dm.prompt).toContain(dm.handed[400]);
    });

    it("a live session is told when the index grows past the hard limit, and when its hidden tail changes", () => {
      write(numbered(400));
      const live = build(false).handed;
      // A 401st line is not shown, but the cut it causes is a change.
      write(numbered(401));
      const grown = promptContextSnapshot({ strict: true });
      const first = classifyPromptContextChange({ memory: live, people: [] }, { memory: grown.memory, people: [] });
      expect(first.kind === "note" && first.body).toContain('+ (cut at the 400-line limit: 1 line omitted after the line starting "- line 400")');
      // Another line in the hidden tail changes the count in the notice.
      write(numbered(402));
      const second = classifyPromptContextChange({ memory: grown.memory, people: [] }, { memory: promptContextSnapshot({ strict: true }).memory, people: [] });
      expect(second.kind === "note" && second.body).toContain("+ (cut at the 400-line limit: 2 lines omitted");
      expect(second.kind === "note" && second.body).toContain("- (cut at the 400-line limit: 1 line omitted");
    });

    it("a sub-session prompt carries neither the index nor the reminder", () => {
      write(numbered(401));
      const prompt = buildSubsessionPrompt({ agentName: "Tomo", ownerName: "Owner" });
      expect(prompt).not.toContain(REMINDER);
      expect(prompt).not.toContain("- line 1");
      expect(prompt).not.toContain("(cut at the");
    });

    describe("fitMemoryIndex", () => {
      it("returns the same array, with no notice, when nothing is cut", () => {
        const lines = numbered(400);
        expect(fitMemoryIndex(lines)).toEqual({ shown: lines });
        expect(fitMemoryIndex([])).toEqual({ shown: [] });
      });

      it("names the last non-blank line shown, by code point, at most 60 of them", () => {
        const long = `- ${"😀".repeat(80)}`;
        const { shown, notice } = fitMemoryIndex([...numbered(398), long, "", "- over"]);
        expect(shown).toHaveLength(400);
        expect(notice).toBe(`(cut at the 400-line limit: 1 line omitted after the line starting "- ${"😀".repeat(58)}")`);
      });

      it("a first line over the byte limit by itself is omitted, and the notice says so", () => {
        const { shown, notice } = fitMemoryIndex(["z".repeat(32 * 1024 + 1), "- next"]);
        expect(shown).toEqual([]);
        expect(notice).toBe("(cut at the 32 KB limit: 2 lines omitted from the top: the first line alone is over it)");
      });

      it("a shown part that is all blank lines is described as that, not as a first line over the limit", () => {
        const { shown, notice } = fitMemoryIndex([...Array.from({ length: 400 }, () => ""), "- public entry"]);
        expect(shown).toHaveLength(400);
        expect(notice).toBe("(cut at the 400-line limit: 1 line omitted after the first 400 lines, all blank)");
      });

      it("a line that lands exactly on 32 KB is kept", () => {
        const { shown, notice } = fitMemoryIndex(["z".repeat(32 * 1024)]);
        expect(shown).toHaveLength(1);
        expect(notice).toBeUndefined();
      });
    });
  });

  describe("private memory filtering for group sessions", () => {
    const memoryDir = join(TOMO_WORKSPACE, "memory");
    const memoryFile = join(memoryDir, "MEMORY.md");

    beforeEach(() => {
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(memoryFile, [
        "- [Public](public.md) — visible everywhere",
        "- [Private](private/secret.md) — DM only",
        "- [PrivateDotSlash](./private/other.md) — DM only too",
      ].join("\n") + "\n");
    });

    afterEach(() => {
      rmSync(memoryFile, { force: true });
    });

    it("DM sessions see private/ entries", () => {
      const prompt = buildSystemPrompt({ isGroup: false });
      expect(prompt).toContain("visible everywhere");
      expect(prompt).toContain("DM only");
      expect(prompt).toContain("DM only too");
    });

    it("group sessions have private/ entries filtered out", () => {
      const prompt = buildSystemPrompt({ isGroup: true });
      expect(prompt).toContain("visible everywhere");
      expect(prompt).not.toContain("DM only");
      expect(prompt).not.toContain("DM only too");
    });

    it("the identity prompt (what retires sessions) leaves MEMORY.md out", () => {
      const identity = buildIdentityPrompt();
      expect(identity).toContain("HARNESS");
      expect(identity).not.toContain("visible everywhere");
      expect(identity).not.toContain("# MEMORY");
      expect(identity).not.toContain("# PEOPLE");
    });

    it("the context snapshot matches what each audience's prompt holds", () => {
      for (const isGroup of [false, true]) {
        let built: { memory: string[] } | undefined;
        buildSystemPrompt({ isGroup, onContext: (c) => { built = c; } });
        expect(promptContextSnapshot({ isGroup }).memory).toEqual(built!.memory);
      }
      expect(promptContextSnapshot({ isGroup: false }).memory).toHaveLength(3);
      const group = promptContextSnapshot({ isGroup: true }).memory;
      expect(group).toEqual(["- [Public](public.md) — visible everywhere"]);
    });

    describe("the dm: session's shared variant (a group chat is part of the conversation)", () => {
      const publicPeople = join(memoryDir, "people");
      const privatePeople = join(memoryDir, "private", "people");

      beforeEach(() => {
        mkdirSync(publicPeople, { recursive: true });
        mkdirSync(privatePeople, { recursive: true });
        writeFileSync(join(publicPeople, "pat.md"), "---\nname: Pat Public\naliases: patty\n---\n\nNotes.\n");
        writeFileSync(join(privatePeople, "quinn.md"), "---\nname: Quinn Private\naliases: qq\n---\n\nNotes.\n");
      });

      afterEach(() => {
        rmSync(publicPeople, { recursive: true, force: true });
        rmSync(join(memoryDir, "private"), { recursive: true, force: true });
      });

      it("leaves out the index lines that link into private/, and private people", () => {
        const prompt = buildSystemPrompt({ shared: true });
        expect(prompt).toContain("visible everywhere");
        expect(prompt).not.toContain("DM only");
        expect(prompt).not.toContain("private/secret.md");
        expect(prompt).not.toContain("private/other.md");
        expect(prompt).toContain("Pat Public");
        expect(prompt).not.toContain("Quinn Private");
        expect(prompt).not.toContain("qq");
      });

      it("the full variant still has both (the fixture is not vacuous)", () => {
        const prompt = buildSystemPrompt();
        expect(prompt).toContain("private/secret.md");
        expect(prompt).toContain("private/other.md");
        expect(prompt).toContain("Quinn Private");
        expect(prompt).toContain("Pat Public");
      });

      it("says what is not loaded instead of the DM's own private-memory section", () => {
        const prompt = buildSystemPrompt({ shared: true });
        expect(prompt).toContain(SHARED_PRIVATE_MEMORY_NOTE);
        expect(prompt).toContain("A group chat is part of this conversation now");
        expect(prompt).toContain("Don't bring private memory into this conversation while the group is here.");
        expect(prompt).not.toContain("## Private memories (DM-only)");
        expect(prompt).toContain("are not listed here while a group chat is part of this conversation");
        // The full and the group prompt say nothing of it.
        expect(buildSystemPrompt()).not.toContain("A group chat is part of this conversation now");
        expect(buildSystemPrompt({ isGroup: true })).not.toContain("A group chat is part of this conversation now");
      });

      it("says private/MEMORY.md is not loaded, and leaves out its block and private/ in the list", () => {
        writeFileSync(join(memoryDir, "private", "MEMORY.md"), "## Private\n- PRIVATE-CORE-LINE\n");
        writeFileSync(join(memoryDir, "private", "health.md"), "---\ndescription: PRIVATE-TOPIC.\n---\nx\n");
        const prompt = buildSystemPrompt({ shared: true });
        expect(prompt).toContain("so private/MEMORY.md, the files under private/ and private people records are not loaded");
        expect(prompt).not.toContain("## private/MEMORY.md");
        expect(prompt).not.toContain("PRIVATE-CORE-LINE");
        expect(prompt).not.toContain("PRIVATE-TOPIC");
        expect(prompt).not.toContain("When unsure, choose private/.");
        const full = buildSystemPrompt();
        expect(full).toContain("PRIVATE-CORE-LINE");
        expect(full).toContain("- private/health.md — PRIVATE-TOPIC.");
      });

      it("is otherwise the DM prompt: the owner notes stay, the group's sections do not appear", () => {
        const prompt = buildSystemPrompt({ shared: true, subsessions: true });
        expect(prompt).toContain("## Your Home");
        expect(prompt).toContain("## Long tasks");
        expect(prompt).not.toMatch(/restricted to DM sessions/i);
      });

      it("hands the session the lines it was built from: the filtered ones", () => {
        let built: { memory: string[]; people: string[] } | undefined;
        buildSystemPrompt({ shared: true, onContext: (c) => { built = c; } });
        expect(built!.memory).toEqual(["- [Public](public.md) — visible everywhere"]);
        expect(built!.people.join("\n")).toContain("Pat Public");
        expect(built!.people.join("\n")).not.toContain("Quinn Private");
      });

      it("carries no over-budget reminder: the index is not reorganized while a group is here", () => {
        writeFileSync(memoryFile, Array.from({ length: 201 }, (_, i) => `- line ${i}`).join("\n") + "\n");
        expect(buildSystemPrompt()).toContain("over its 200-line");
        expect(buildSystemPrompt({ shared: true })).not.toContain("over its 200-line");
      });

      it("isGroup wins over shared: a group session never gets the DM-only notes", () => {
        const prompt = buildSystemPrompt({ isGroup: true, shared: true });
        expect(prompt).not.toContain("## Your Home");
        expect(prompt).toMatch(/restricted to DM sessions/i);
      });
    });

    it("DM prompt tells the agent to use memory/private/ for sensitive notes", () => {
      const prompt = buildSystemPrompt({ isGroup: false });
      expect(prompt).toContain("memory/private/");
      expect(prompt).toContain("**private/** is for what must stay between you and the owner");
    });

    it("group prompt tells the agent that memory/private/ is unreachable", () => {
      const prompt = buildSystemPrompt({ isGroup: true });
      expect(prompt).toContain("memory/private/");
      expect(prompt).toMatch(/restricted to DM sessions/i);
    });
  });
});
