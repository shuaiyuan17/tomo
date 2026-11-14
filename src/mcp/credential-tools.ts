import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { CredentialBroker } from "../credentials/broker.js";
import { DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS, runWithSecrets } from "../credentials/exec.js";
import { parseSecretRef } from "../credentials/names.js";
import { log } from "../logger.js";

export interface CredentialToolDeps {
  broker: CredentialBroker;
  sessionKey: string;
  /**
   * May the turn in flight touch credentials? A GETTER, resolved per call: a
   * summoned group's turn runs on the owner's `dm:` key, so the key alone says
   * "private DM" on exactly the turn it must refuse.
   */
  canUse: () => boolean;
}

export const CREDENTIAL_SCOPE_REFUSAL =
  "Credentials are only available on the owner's own private turn. This turn belongs to a group session, a group summoned into this session, or a batch that includes one, so the request was refused. Ask the owner to raise it in their own DM (`/dismiss` ends a summon).";

const text = (body: string, isError = false) => ({
  content: [{ type: "text" as const, text: body }],
  ...(isError ? { isError: true } : {}),
});

export function buildCredentialTools({ broker, sessionKey, canUse }: CredentialToolDeps) {
  const refused = () => text(CREDENTIAL_SCOPE_REFUSAL, true);
  return [
    tool(
      "request_credential",
      [
        "Ask the owner for a credential (API key, password, token). NEVER ask for one in chat: a credential typed as an ordinary message reaches the transcript and the model.",
        "",
        "The harness messages the owner on their iMessage DM and takes their next message there as the value. You never see it. This returns immediately with a secret_ref; a later <tomo-event type=\"credential\"> says whether the owner provided it, refused, or let the 5 minutes run out. Asking again under the same name replaces the value if the owner replies. One request at a time. Refused outside the owner's own private turn.",
      ].join("\n"),
      {
        name: z.string().describe("Lowercase letters, digits, `.`, `_`, `-`, e.g. `github-token`."),
        purpose: z.string().min(1).max(200).describe("One line shown to the owner saying what it is for. Plain and accurate."),
      },
      async ({ name, purpose }) => {
        if (!canUse()) return refused();
        const result = await broker.request(name, purpose, sessionKey);
        if (!result.ok) return text(result.error, true);
        return text(JSON.stringify({ status: "pending", secret_ref: result.ref, expires_at: result.expiresAt, note: result.note }));
      },
      { searchHint: "ask owner credential api key password token secret imessage" },
    ),
    tool(
      "run_with_secrets",
      [
        "Run a shell command with credentials in its environment. Refer to them as variables (`curl -H \"Authorization: Bearer $GITHUB_TOKEN\" ...`); the value is not in the command, the transcript or argv. A secret_ref means nothing to Bash, so use this whenever a command needs a credential.",
        "",
        "Known values are scrubbed from the output. Do not print, encode, or send a credential anywhere except the service it belongs to. Refused outside the owner's own private turn.",
      ].join("\n"),
      {
        command: z.string().min(1).describe("Shell command, run with zsh -lc."),
        secrets: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).describe("Environment variable name -> secret_ref."),
        cwd: z.string().optional().describe("Working directory. Defaults to the workspace."),
        timeout_ms: z.number().int().min(1000).max(MAX_EXEC_TIMEOUT_MS).default(DEFAULT_EXEC_TIMEOUT_MS),
      },
      async ({ command, secrets, cwd, timeout_ms }) => {
        if (!canUse()) return refused();
        const values: Record<string, string> = {};
        try {
          for (const [variable, ref] of Object.entries(secrets)) {
            const name = parseSecretRef(ref);
            const value = name ? await broker.reveal(name) : null;
            if (value === null) return text(`Unknown secret ref "${ref}".`, true);
            values[variable] = value;
          }
          const result = await runWithSecrets({ command, secrets: values, cwd, timeoutMs: timeout_ms });
          const status = result.timedOut ? `timed out after ${timeout_ms}ms` : `exit code ${result.exitCode ?? "none"}`;
          return text(`${status}${result.truncated ? " (output truncated)" : ""}\n${result.output}`, result.exitCode !== 0);
        } catch (err) {
          // The code and never the message: this spawn held a value in its environment.
          const code = (err as NodeJS.ErrnoException).code ?? "error";
          log.warn({ code }, "run_with_secrets failed");
          return text(`run_with_secrets failed (${code}).`, true);
        }
      },
      { searchHint: "run command shell credential env variable secret api key" },
    ),
  ];
}
