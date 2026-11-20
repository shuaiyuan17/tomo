/**
 * What the owner reads about a credential request in chat (src/credentials/broker.ts).
 * What the requesting agent is told is model-facing and not here. "cancel" is the
 * word the broker accepts and stays as is.
 */
export const credentials = {
  prompt: "Tomo is asking for a credential.\nName: {{name}}\nPurpose (written by the agent, not verified): {{purpose}}",
  promptReplaces: "Tomo is asking for a credential.\nName: {{name}}\nPurpose (written by the agent, not verified): {{purpose}}\nYour reply replaces the value already stored under this name.",
  promptTelegram: "\nYour next message in this chat is stored as this credential and is not shown to the model. Tomo deletes it from the chat once it is stored.",
  promptMessages: "\nYour next message in this chat is stored as this credential and is not shown to the model. It stays in Messages, so delete it afterwards.",
  promptCancel: "Reply \"cancel\" to refuse. Expires in {{minutes}} minutes.",
  deleted: " It was deleted from this chat.",
  heldBack: "Tomo's credential state is unreadable, so this message was held back and not shown to the model.{{deleted}} Repair or remove ~/.tomo/data/credentials/state.json.",
  late: "A message sent around the time the request for {{name}} expired arrived late. It was not stored and not shown to the model.{{deleted}} If it was something else, send it again.",
  where: { web: "the web UI's card", telegram: "Telegram", imessage: "iMessage" },
  offChannel: "Tomo is waiting for {{name}} in {{where}}, so this message was dropped and not shown to the model.{{deleted}} Answer there, or cancel there.",
  cancelled: "Cancelled the request for {{name}}.",
  invalid: "That was not stored and not shown to the model. {{tidy}} {{name}} needs plain text (printable ASCII, {{min}} to {{max}} characters) and no attachment. Send it again, or reply \"cancel\".",
  storeFailed: "Could not store {{name}}: the credential store is unavailable. Nothing was shown to the model. {{tidy}}",
  stored: "Stored as {{name}}. {{tidy}}",
  tidyDeleted: "Your message was deleted from this chat.",
  tidyTelegram: "Tomo could not delete your message, so delete it from this chat yourself.",
  tidyMessages: "Your message is still in Messages, so delete it there.",
  expired: "The request for {{name}} expired. Do NOT send it now: messages here go to the model again.",
} as const;
