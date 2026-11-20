/**
 * What the owner reads about a group's permission request (src/permissions/broker.ts).
 * The reply syntax ("1 K7Q", "revoke G-…") is the parser's and stays as is.
 * What the requesting agent is told (outcomeText) is model-facing and not here.
 */
export const permissions = {
  marker: "Permission request {{code}}",
  access: { read: "read", write: "read and write" },
  dm: "Permission request {{code}}: a group wants to {{access}} a path.\n{{group}} · {{path}}\nReason (from the agent, not verified): {{reason}}\nReply \"1 {{code}}\" allow once (file tools only; shell needs always), \"2 {{code}}\" always allow, \"3 {{code}}\" deny, or quote this. Expires in {{minutes}} min.",
  allowedOnce: "Allowed once ({{code}}): {{group}} may {{access}} {{path}} for one turn, with file tools (not the shell).",
  allowedAlways: "Always allowed ({{code}}): {{group}} may {{access}} {{path}}. Saved to its sandbox config as {{grant}}; reply \"revoke {{grant}}\" to take it back.",
  denied: "Denied ({{code}}).",
  revokeUnknown: "No \"always allow\" has the id {{grant}}, so nothing was revoked.",
  revoked: "Revoked {{grant}}: {{group}} can no longer reach {{path}}.",
  revokeFailed: "Could not revoke {{grant}}: the config file could not be written.",
  closedLate: "Permission request {{code}} is no longer open (it was answered or it expired). Nothing changed.",
  closed: "Permission request {{code}} is no longer open. Nothing changed.",
  alwaysUnwritable: "Could not save \"always allow\" for {{code}}: the config file could not be written. The request is still open; reply again, or allow once.",
} as const;
