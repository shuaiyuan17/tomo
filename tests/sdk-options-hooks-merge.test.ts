import { describe, expect, it } from "vitest";
import { UNDELIVERED_REPLY_NOTICE, UNDELIVERED_REPLY_TURN_END_NOTICE, buildHooksOption, makeTurnBudget, mergeHooks } from "../src/agent/sdk-options.js";

describe("mergeHooks", () => {
  it("concatenates entries when two producers register the same event", () => {
    const a = { PreToolUse: [{ hooks: ["guard-a"] }] };
    const b = { PreToolUse: [{ hooks: ["guard-b"] }], PostToolBatch: [{ hooks: ["budget"] }] };
    const merged = mergeHooks(mergeHooks({}, a), b);
    // Before the fix, Object.assign would have left only guard-b here.
    expect(merged.PreToolUse).toEqual([{ hooks: ["guard-a"] }, { hooks: ["guard-b"] }]);
    expect(merged.PostToolBatch).toEqual([{ hooks: ["budget"] }]);
  });

  it("keeps producers that use different events independent", () => {
    const merged = mergeHooks(mergeHooks({}, { A: [1] }), { B: [2] });
    expect(merged).toEqual({ A: [1], B: [2] });
  });

  it("ignores non-array values instead of throwing", () => {
    const merged = mergeHooks({}, { A: "nope" as unknown });
    expect(merged).toEqual({});
  });
});

describe("buildHooksOption — the two PreToolUse guards coexist", () => {
  it("registers the agent-profile guard ALONGSIDE the private-memory bar", () => {
    const { hooks } = buildHooksOption({
      turnBudget: makeTurnBudget(),
      maxTurns: 50,
      sessionKey: "dm:shuai",
      privateMemoryBar: () => null,
      agentProfile: () => undefined,
    }) as { hooks: Record<string, Array<{ hooks: unknown[] }>> };

    // The exact regression mergeHooks was introduced for: with the old
    // Object.assign, adding this second producer would have left ONE entry
    // here and the private-memory bar would have vanished in silence.
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse.every((entry) => entry.hooks.length === 1)).toBe(true);
    expect(hooks.PostToolBatch).toHaveLength(1);
  });

  // FAIL CLOSED. A matcher without `onFailure` defaults to "continue": a guard
  // callback that throws lets the tool call through, and under
  // bypassPermissions nothing else stops it. Every security guard must say
  // "block"; the bookkeeping hooks (turn budget, undelivered nudge) must not,
  // since a crash there should never cost the user a tool call.
  it("every PreToolUse guard fails closed; the bookkeeping hooks do not", () => {
    const { hooks } = buildHooksOption({
      turnBudget: makeTurnBudget(),
      maxTurns: 50,
      sessionKey: "telegram:-100123",
      privateMemoryBar: () => "group-session",
      agentProfile: () => undefined,
      undeliveredReply: () => false,
    }) as { hooks: Record<string, Array<{ onFailure?: string }>> };

    expect(hooks.PreToolUse).toHaveLength(2);
    for (const entry of hooks.PreToolUse) expect(entry.onFailure).toBe("block");
    for (const [event, entries] of Object.entries(hooks)) {
      if (event === "PreToolUse") continue;
      for (const entry of entries) expect(entry.onFailure).toBeUndefined();
    }
  });

  it("installs neither guard when neither is asked for", () => {
    const { hooks } = buildHooksOption({ turnBudget: makeTurnBudget(), maxTurns: 50 }) as {
      hooks: Record<string, unknown[]>;
    };
    expect(hooks.PreToolUse).toBeUndefined();
  });

  // LAST-WINS ON `updatedInput`, which is why the ORDER is now load-bearing.
  //
  // The private-memory guard returns `updatedInput` (the `sandbox-exec` rewrite).
  // When two PreToolUse hooks both return one, the CLI keeps the LAST and says
  // nothing — so a rewriting hook registered after this one would silently
  // discard the sandbox wrap and hand the model an unsandboxed shell. Deny
  // precedence is unaffected by order (any hook's `deny` wins), so the ordering
  // exists purely to keep the rewrite final.
  describe("the private-memory guard is the last PreToolUse producer", () => {
    type Hook = (input: { tool_name: string; tool_input: unknown }) => Promise<{
      hookSpecificOutput?: {
        permissionDecision?: string;
        permissionDecisionReason?: string;
        updatedInput?: Record<string, unknown>;
      };
    }>;

    const preToolUse = (): Hook[] => {
      const { hooks } = buildHooksOption({
        maxTurns: 50,
        sessionKey: "dm:shuai",
        privateMemoryBar: () => "group-session",
        agentProfile: () => undefined,
      }) as { hooks: Record<string, Array<{ hooks: Hook[] }>> };
      return hooks.PreToolUse.flatMap((entry) => entry.hooks);
    };

    const PRIVATE_READ = {
      tool_name: "Read",
      tool_input: { file_path: "memory/private/secret.md" },
    };

    it("puts it at the END of the array, after the agent-profile guard", async () => {
      const hooks = preToolUse();
      expect(hooks).toHaveLength(2);
      // Identified by behaviour rather than by index alone: only the
      // private-memory guard denies a private Read on a barred turn, and the
      // agent-profile guard says nothing for a main-thread call (no agent_id).
      expect(await hooks[0]!(PRIVATE_READ)).toEqual({});
      const last = await hooks[hooks.length - 1]!(PRIVATE_READ);
      expect(last.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(last.hookSpecificOutput?.permissionDecisionReason)
        .toContain("not accessible from group sessions");
    });

    it("is the ONLY producer that returns updatedInput, so last-wins is safe", async () => {
      const hooks = preToolUse();
      const earlier = hooks.slice(0, -1);
      expect(earlier).not.toHaveLength(0);
      for (const hook of earlier) {
        for (const call of [
          { tool_name: "Bash", tool_input: { command: "ls -la" } },
          { tool_name: "Bash", tool_input: { command: "cat memory/private/x" } },
          PRIVATE_READ,
        ]) {
          expect((await hook(call)).hookSpecificOutput?.updatedInput).toBeUndefined();
        }
      }
    });
  });

  it("adds the todo-store guard, fail-closed and deny-only, before the private-memory guard", async () => {
    type Hook = (input: { tool_name: string; tool_input: unknown }) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; updatedInput?: unknown } }>;
    const { hooks } = buildHooksOption({
      maxTurns: 50,
      sessionKey: "dm:shuai",
      privateMemoryBar: () => null,
      agentProfile: () => undefined,
      todosDir: () => "/th/data/todos",
    }) as { hooks: Record<string, Array<{ onFailure?: string; hooks: Hook[] }>> };
    expect(hooks.PreToolUse).toHaveLength(3);
    for (const entry of hooks.PreToolUse) expect(entry.onFailure).toBe("block");
    const todoGuard = hooks.PreToolUse[1].hooks[0];
    // On the owner's own turn (no bar), a direct write is still denied.
    const denied = await todoGuard({ tool_name: "Write", tool_input: { file_path: "/th/data/todos/todos.json", content: "{}" } });
    expect(denied.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(denied.hookSpecificOutput?.updatedInput).toBeUndefined();
    expect(await todoGuard({ tool_name: "Bash", tool_input: { command: "ls -la" } })).toEqual({});
  });

  it("installs the agent-profile guard on its own", () => {
    const { hooks } = buildHooksOption({ maxTurns: 50, agentProfile: () => undefined }) as {
      hooks: Record<string, unknown[]>;
    };
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolBatch).toBeUndefined();
  });
});

describe("undelivered-reply nudge", () => {
  type Hook = () => Promise<{ hookSpecificOutput?: { additionalContext?: string } }>;
  const postToolBatchHooks = (hooks: Record<string, unknown[]>): Hook[] =>
    (hooks.PostToolBatch as Array<{ hooks: Hook[] }>).flatMap((entry) => entry.hooks);

  it("is not installed when the session offers no flag", () => {
    const { hooks } = buildHooksOption({ maxTurns: 50, turnBudget: makeTurnBudget() }) as { hooks: Record<string, unknown[]> };
    expect(postToolBatchHooks(hooks)).toHaveLength(1);
  });

  it("sits beside the turn-budget hook and fires only while the flag reads true", async () => {
    let pending = true;
    const read = () => { const p = pending; pending = false; return p; };
    const { hooks } = buildHooksOption({
      maxTurns: 50,
      turnBudget: makeTurnBudget(),
      undeliveredReply: read,
    }) as { hooks: Record<string, unknown[]> };
    const batch = postToolBatchHooks(hooks);
    // Both producers present — this is the case mergeHooks exists for.
    expect(batch).toHaveLength(2);

    const first = await batch[1]!();
    expect(first.hookSpecificOutput?.additionalContext).toBe(UNDELIVERED_REPLY_NOTICE);
    // Read-and-clear on the session side: the second batch says nothing.
    const second = await batch[1]!();
    expect(second).toEqual({});
  });

  it("is installed on a chat session's key", () => {
    const { hooks } = buildHooksOption({ maxTurns: 50, turnBudget: makeTurnBudget(), sessionKey: "dm:alex", undeliveredReply: () => true }) as { hooks: Record<string, unknown[]> };
    expect(postToolBatchHooks(hooks)).toHaveLength(2);
  });

  it("is never installed on a task session: its text is not delivered to anyone by design", async () => {
    let reads = 0;
    const { hooks } = buildHooksOption({
      maxTurns: 50,
      turnBudget: makeTurnBudget(),
      sessionKey: "task:s1",
      undeliveredReply: () => { reads++; return true; },
    }) as { hooks: Record<string, unknown[]> };
    const batch = postToolBatchHooks(hooks);
    expect(batch).toHaveLength(1);
    for (const hook of batch) expect((await hook()).hookSpecificOutput?.additionalContext ?? "").not.toContain(UNDELIVERED_REPLY_NOTICE);
    expect(reads).toBe(0);
  });

  it("asks for a message to the user, never for the dropped words back", () => {
    // A request to reproduce reasoning in the reply is refused by the API
    // (reasoning_extraction): the notices name no source and ask for no copy.
    for (const notice of [UNDELIVERED_REPLY_NOTICE, UNDELIVERED_REPLY_TURN_END_NOTICE]) {
      expect(notice).not.toMatch(/think|reason|verbatim|repeat|restate|again|word for word|exact|narrat/i);
      expect(notice).toContain("write it now as your reply");
    }
  });
});

describe("buildHooksOption — groupSandbox threaded to the guard", () => {
  type Hook = (input: { tool_name: string; tool_input: unknown }) => Promise<{
    hookSpecificOutput?: {
      permissionDecision?: string;
      updatedInput?: Record<string, unknown>;
    };
  }>;

  it("passes an unsandboxed group entry through to privateMemoryGuardHooks", async () => {
    const KEY = "imessage:any;+;test";
    const { hooks } = buildHooksOption({
      maxTurns: 50,
      sessionKey: KEY,
      privateMemoryBar: () => "group-session" as const,
      groupSandbox: () => ({ groups: { [KEY]: { extraRead: [], extraWrite: [], unsandboxed: true } } }),
    }) as { hooks: Record<string, Array<{ hooks: Hook[] }>> };

    // The private-memory guard is the last PreToolUse entry.
    const guard = hooks.PreToolUse[hooks.PreToolUse.length - 1].hooks[0];
    const result = await guard({ tool_name: "Bash", tool_input: { command: "ls" } });
    // Allowlisted session: no sandbox rewrite, no deny — just {}.
    expect(result).toEqual({});
  });
});

describe("buildHooksOption — background launch guard (pending compact)", () => {
  it("is installed when asked for, fails closed, and denies a background launch while the getter says so", async () => {
    let denial: string | null = "a rollup is pending";
    const { hooks } = buildHooksOption({
      maxTurns: 0,
      sessionKey: "dm:owner",
      backgroundLaunchDenial: () => denial,
    }) as { hooks: Record<string, Array<{ onFailure?: string; hooks: Array<(i: unknown) => Promise<unknown>> }>> };
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0].onFailure).toBe("block");
    const hook = hooks.PreToolUse[0].hooks[0];
    const launch = { tool_name: "Agent", tool_input: { prompt: "x", run_in_background: true } };
    expect(await hook(launch)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    denial = null;
    expect(await hook(launch)).toEqual({});
  });

  it("is absent without the getter", () => {
    expect(buildHooksOption({ maxTurns: 0, sessionKey: "dm:owner" })).toEqual({});
  });
});
