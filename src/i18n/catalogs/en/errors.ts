/**
 * Tomo's own failures as the owner reads them inside a reply ("Could not
 * rewind: …"), by kind (src/i18n/error-detail.ts). Each English text is the
 * error's `.message`, unchanged, which is also what logs and the model see.
 * Anything not ours (an OS, SDK, HTTP or OAuth-provider error) is shown as
 * its own detail instead.
 */
export const errors = {
  lockTimeout: "could not acquire the lock at {{path}} within {{ms}}ms",
  lockTimeoutHeld: "could not acquire the lock at {{path}} within {{ms}}ms (held by pid {{pid}})",
  todoStore: {
    read: "todo store could not be read: {{path}} ({{detail}}). Nothing was changed; fix or restore the file.",
    conflict: "todo store changed while it was being written: {{path}}. Nothing was overwritten; try again.",
  },
  rewind: {
    usage: "Use /rewind or /rewind <positive integer>.",
    invalidSession: "Invalid SDK session ID.",
    changed: "Session history changed during rewind. Try again.",
    writing: "Session history is still being written. Try /rewind again shortly.",
    keptChanging: "Session history kept changing during rewind. Try again in a moment.",
    unreadable: "Unreadable session history.",
    tooFew_one: "Only {{count}} recorded human message(s) can be rewound in the current context. Older or compacted messages may be unavailable; /new starts fresh.",
    tooFew_other: "Only {{count}} recorded human message(s) can be rewound in the current context. Older or compacted messages may be unavailable; /new starts fresh.",
    boundary: "Cannot safely resolve the rewind boundary.",
    noCompletedTurn: "Every recorded message in the current context arrived during a tool call, so there is no completed turn to return to. /new starts fresh.",
    branchNotRemoved: "Could not remove a rejected rewind branch. Try /rewind again.",
    stopping: "Tomo is stopping. Try again after restart.",
    noConversation: "No active conversation to rewind.",
    inProgress: "A rewind is already in progress.",
  },
  login: {
    otherOwnerInProgress: "Another owner already has a Claude login in progress",
    expired: "Claude login expired after 10 minutes; run /login again",
    submitFailed: "Could not submit Claude login code: {{detail}}",
    startFailed: "Could not start Claude login: {{detail}}",
    exitedSignal: "Claude login did not complete (signal {{signal}})",
    exitedCode: "Claude login did not complete (exit code {{code}})",
    noneWaiting: "No Claude login is waiting; send /login first",
    otherOwner: "This Claude login belongs to another owner",
    verifying: "That Claude login code is already being verified",
    invalidCode: "Invalid authorization code; paste the complete code returned by Claude",
    stateMismatch: "Authorization code does not match the active /login request",
    cancelled: "Claude login cancelled",
    stopped: "Tomo stopped during Claude login",
    verificationFailed: "Claude login verification failed",
    verificationFailedDetail: "Claude login verification failed: {{detail}}",
  },
  mcpLogin: {
    unknownServer: "Unknown external MCP server \"{{server}}\"",
    noOAuth: "MCP server \"{{server}}\" does not use OAuth",
    noHeaders: "MCP server \"{{server}}\" cannot use OAuth headers",
    notInteractive: "MCP server \"{{server}}\" did not start an interactive OAuth flow",
  },
} as const;
