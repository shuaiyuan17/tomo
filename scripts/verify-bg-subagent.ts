/**
 * Verification probe: does the Claude Agent SDK, in long-lived streaming-input
 * mode (the way LiveSession uses it), automatically wake the model with a NEW
 * turn when a background subagent finishes — WITHOUT us sending another user
 * message?
 *
 * This is the load-bearing assumption behind background-subagent support in
 * Tomo. If the SDK never produces that unsolicited turn, the whole feature is
 * a non-starter and no amount of LiveSession plumbing will help.
 *
 * HOW TO RUN (on a machine with creds — NOT the remote container):
 *   1. npm install            # need node_modules
 *   2. export ANTHROPIC_API_KEY=sk-...        # or your LiteLLM gateway:
 *      #   export ANTHROPIC_BASE_URL=http://localhost:4000
 *      #   export ANTHROPIC_API_KEY=<gateway key>
 *   3. npx tsx scripts/verify-bg-subagent.ts
 *
 * WHAT TO LOOK FOR: the script prints a numbered log of every SDK event. The
 * verdict at the end tells you whether a second (unsolicited) turn arrived
 * after the first `result`. That second turn is what LiveSession would need to
 * intercept and route to the channel.
 */
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// ---- streaming input generator (mirrors LiveSession.messageGenerator) ----
let pushUserMessage: ((m: SDKUserMessage) => void) | null = null;
let inputClosed = false;

async function* messageGenerator(): AsyncGenerator<SDKUserMessage> {
  while (!inputClosed) {
    const msg = await new Promise<SDKUserMessage | null>((resolve) => {
      pushUserMessage = (m) => resolve(m);
      // If we close input while waiting, resolve null to end the generator.
      if (inputClosed) resolve(null);
    });
    pushUserMessage = null;
    if (msg === null) return;
    yield msg;
  }
}

function sendUserText(text: string) {
  const msg: SDKUserMessage = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] as never },
    parent_tool_use_id: null,
  } as SDKUserMessage;
  if (!pushUserMessage) throw new Error("generator not waiting for input");
  pushUserMessage(msg);
}

// ---- the probe ----
async function main() {
  const q = query({
    prompt: messageGenerator(),
    options: {
      // Mirror Tomo: bypass permissions so the background subagent can run its
      // tools without prompting (background turns auto-deny anything that would
      // prompt — bypass avoids that trap entirely).
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash", "Agent", "Read", "Glob", "Grep"],
      includePartialMessages: true,
      maxTurns: 30,
    },
  });

  // Ask for a background subagent that takes ~15s, and tell the model to
  // return to us IMMEDIATELY without waiting. The question is what happens
  // ~15s later when that subagent finishes.
  sendUserText(
    "Use the Agent tool with run_in_background: true to launch a subagent " +
      "whose task is: run `sleep 15 && echo DONE_FROM_BG` in Bash and report " +
      "the output. As soon as you've LAUNCHED it (do not wait for it), reply " +
      "to me with exactly: LAUNCHED. Later, when the background subagent " +
      "finishes, tell me what its output was.",
  );

  let eventNum = 0;
  let firstResultSeen = false;
  let firstResultAt = 0;
  let sawUnsolicitedTurn = false;
  let sawDoneMarker = false;

  // Safety: stop iterating ~40s after the first result so the script always
  // terminates even if no second turn ever arrives.
  let watchdog: NodeJS.Timeout | null = null;
  const stop = () => {
    inputClosed = true;
    q.close?.();
  };

  for await (const event of q) {
    eventNum++;
    const e = event as Record<string, unknown>;
    const type = e.type as string;
    const subtype = e.subtype as string | undefined;
    const parentId = (e as { parent_tool_use_id?: string }).parent_tool_use_id;

    // Pull any visible text out of assistant events.
    let textPreview = "";
    if (type === "assistant") {
      const content = (e as { message?: { content?: unknown[] } }).message?.content ?? [];
      for (const b of content) {
        const blk = b as { type?: string; text?: string; name?: string };
        if (blk.type === "text" && blk.text) textPreview += blk.text;
        if (blk.type === "tool_use") textPreview += `[tool_use:${blk.name}]`;
      }
    }
    if (textPreview.includes("DONE_FROM_BG")) sawDoneMarker = true;

    const sinceFirstResult = firstResultAt ? `+${((Date.now() - firstResultAt) / 1000).toFixed(1)}s` : "";
    console.log(
      `#${eventNum} [${type}${subtype ? ":" + subtype : ""}]` +
        (parentId ? ` parent=${parentId}` : "") +
        (textPreview ? ` text="${textPreview.slice(0, 120).replace(/\n/g, " ")}"` : "") +
        (sinceFirstResult ? ` (${sinceFirstResult} after 1st result)` : ""),
    );

    if (type === "result") {
      if (!firstResultSeen) {
        firstResultSeen = true;
        firstResultAt = Date.now();
        console.log(
          "\n>>> First `result` arrived (foreground turn done). NOT sending " +
            "another user message. Watching for an unsolicited turn...\n",
        );
        // Arm watchdog: give the bg subagent time to finish + wake us.
        watchdog = setTimeout(() => {
          console.log("\n>>> Watchdog fired (40s) — closing.\n");
          stop();
        }, 40_000);
      } else {
        // A SECOND result with no user message in between == unsolicited turn.
        sawUnsolicitedTurn = true;
        console.log("\n>>> SECOND `result` arrived with no user message sent. This is the unsolicited turn.\n");
        if (watchdog) clearTimeout(watchdog);
        stop();
      }
    }
  }

  console.log("\n================ VERDICT ================");
  console.log(`Unsolicited turn after first result : ${sawUnsolicitedTurn ? "YES ✅" : "NO ❌"}`);
  console.log(`Saw background output (DONE_FROM_BG) : ${sawDoneMarker ? "YES" : "NO"}`);
  if (sawUnsolicitedTurn) {
    console.log(
      "\nThe SDK DOES wake the model on background completion. Background-subagent\n" +
        "support is viable: LiveSession needs an unsolicited-turn path (route the\n" +
        "result to the channel via the cron-style delivery queue) + turn-attribution\n" +
        "guard + lifecycle protection.",
    );
  } else {
    console.log(
      "\nNo unsolicited turn observed. Before building anything, dig into WHY:\n" +
        " - Did the model actually use Agent with run_in_background:true? (check the\n" +
        "   tool_use lines above — if it ran sleep inline/foreground, the test is\n" +
        "   invalid; tighten the prompt and retry.)\n" +
        " - Did the foreground turn end before the bg subagent finished? (compare\n" +
        "   timestamps.)\n" +
        " - If Agent genuinely backgrounded and still no wake-up: the SDK does not\n" +
        "   auto-resume in this mode, and the feature needs a different mechanism\n" +
        "   (e.g. polling subagent state) — flag this to the user before proceeding.",
    );
  }
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
