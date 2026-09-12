import { describe, expect, it } from "vitest";
import { UNDELIVERED_REPLY_NOTICE, buildHooksOption, makeTurnBudget, mergeHooks } from "../src/agent/sdk-options.js";

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
});
