/** Harness notices about sub-sessions, to the chat of the scope that owns the task (src/agent/subsessions/service.ts). */
export const subsessions = {
  stuck: "[{{id}} · {{title}}] Paused: {{turns}} turns in a row with no progress. Tell me how to go on, or cancel it.",
  failing: "[{{id}} · {{title}}] Paused: its last turns failed. Tell me to go on, or cancel it.",
  finishedUnanswered: "[{{id}} · {{title}}] Couldn't answer the message it was sent; it stays finished and keeps the message. Write to it again and it gets another try with everything it hasn't answered.",
  stopped: "[{{id}} · {{title}}] Stopped. Tell me to go on, or cancel it.",
  selfRestart: "[{{id}} · {{title}}] Tomo restarted at this task's own request, so it is paused. Tell me to go on when you're ready.",
  failedInterrupted: "[{{id}} · {{title}}] Gave up: restarts cut it short {{restarts}} times in a row. Ask again if it is still needed.",
  failedNoSession: "[{{id}} · {{title}}] Gave up: its conversation could not be found after a restart, and starting over could repeat what it already did. Ask again if it is still needed.",
  registryHold: "⚠️ Tomo can't read its session list (~/.tomo/data/sessions/_sessions.json), so sub-sessions are on hold: running them now would start them without their history. They continue once it can be read again; nothing was cancelled.",
  inputFull: "[{{id}} · {{title}}] A scheduled check-back was dropped: {{max}} messages are already waiting for it. It catches up on those first.",
  recoveryFailed: "⚠️ Tomo could not finish recovering its sub-sessions after the restart (the list could not be saved), so sub-sessions are off until the next start. Nothing was cancelled or deleted.",
  tableUnreadable: "⚠️ Tomo could not read its sub-session list (~/.tomo/data/subsessions.json), so sub-sessions are off until it is repaired. Nothing was cancelled or deleted.",
  tableLost_one: "⚠️ Tomo's sub-session list looks lost or restored from a backup, but {{count}} sub-session conversation still exists. Nothing was deleted; check ~/.tomo/data/subsessions.json.",
  tableLost_other: "⚠️ Tomo's sub-session list looks lost or restored from a backup, but {{count}} sub-session conversations still exist. Nothing was deleted; check ~/.tomo/data/subsessions.json.",
} as const;
