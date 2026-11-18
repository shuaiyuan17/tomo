import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { CredentialBroker, CredentialOrigin } from "../credentials/broker.js";
import { keychainReadCommand } from "../credentials/names.js";

export interface CredentialToolDeps {
  broker: CredentialBroker;
  sessionKey: string;
  /**
   * May the turn in flight touch credentials? A GETTER, resolved per call: a
   * summoned group's turn runs on the owner's `dm:` key, so the key alone says
   * "private DM" on exactly the turn it must refuse.
   */
  canUse: () => boolean;
  /** The chat this turn came in on, resolved per call; null for a cron job, a
   *  heartbeat, or a batch across channels. */
  origin: () => CredentialOrigin | null;
}

export const CREDENTIAL_SCOPE_REFUSAL =
  "Credentials are only available on the owner's own private turn. This turn belongs to a group session, a group summoned into this session, or a batch that includes one, so the request was refused. Ask the owner to raise it in their own DM (`/dismiss` ends a summon).";

const text = (body: string, isError = false) => ({
  content: [{ type: "text" as const, text: body }],
  ...(isError ? { isError: true } : {}),
});

export function buildCredentialTools({ broker, sessionKey, canUse, origin }: CredentialToolDeps) {
  return [
    tool(
      "request_credential",
      [
        "Ask the owner for a credential (API key, password, token). NEVER ask for one in chat: a credential typed as an ordinary message reaches the transcript and the model.",
        "",
        "The harness asks the owner where this turn came from: in iMessage or Telegram their next message in that private chat is taken as the value (Telegram's is then deleted from the chat); in the web UI a password card opens. You never see the value. This returns immediately with a secret_ref; a later <tomo-event type=\"credential\"> says whether the owner provided it, refused, or let the 5 minutes run out. Asking again under the same name replaces the value if the owner answers. One request at a time. Refused outside the owner's own private turn, and on a turn the owner is not typing in (a scheduled job, a heartbeat).",
        "",
        `Once provided, use it in Bash only inside a command substitution, e.g. curl -H "Authorization: Bearer $(${keychainReadCommand("<name>")})" ... so the value never appears in the command text or the transcript. Never echo, print, encode or log it; known values are masked in tool output, literally and only when the command succeeds.`,
      ].join("\n"),
      {
        name: z.string().describe("Lowercase letters, digits, `.`, `_`, `-`, e.g. `github-token`."),
        purpose: z.string().min(1).max(200).describe("One line shown to the owner saying what it is for. Plain and accurate."),
      },
      async ({ name, purpose }) => {
        if (!canUse()) return text(CREDENTIAL_SCOPE_REFUSAL, true);
        const result = await broker.request(name, purpose, sessionKey, origin());
        if (!result.ok) return text(result.error, true);
        return text(JSON.stringify({
          status: "pending", secret_ref: result.ref, asked_on: result.channel, expires_at: result.expiresAt,
          read_with: `$(${keychainReadCommand(name)})`, note: result.note,
        }));
      },
      { searchHint: "ask owner credential api key password token secret keychain" },
    ),
  ];
}
