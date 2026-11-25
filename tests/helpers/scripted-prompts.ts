import type { PromptPort } from "../../src/cli/config/owner-setup.js";
import type { InitPromptPort } from "../../src/cli/init-setup.js";

/** What a scripted prompt answers when the user presses Ctrl-C. */
export const CANCEL = Symbol("cancel");

export interface ScriptedAnswers {
  text?: Array<string | symbol>;
  confirm?: Array<boolean | symbol>;
  select?: Array<string | symbol>;
  multiselect?: Array<string[] | symbol>;
  password?: Array<string | symbol>;
}

/**
 * A scripted prompt port for the setup flows (`tomo config` owner setup,
 * `tomo init`). Answers are consumed in order, per prompt kind; a prompt with
 * no answer left throws, so a flow that asks more than the test expects fails
 * on the question it asked. `InitPromptPort` extends `PromptPort`, so the one
 * port serves both.
 */
export function scriptedPrompts(answers: ScriptedAnswers = {}): {
  port: InitPromptPort & PromptPort;
  /** Every question asked, as `<kind>: <message>`. */
  asked: string[];
  /** Every log line and note, as `<level>: <message>`. */
  logs: string[];
  /** The answers not used yet. */
  remaining: Required<ScriptedAnswers>;
} {
  const asked: string[] = [];
  const logs: string[] = [];
  const remaining: Required<ScriptedAnswers> = {
    text: [...(answers.text ?? [])],
    confirm: [...(answers.confirm ?? [])],
    select: [...(answers.select ?? [])],
    multiselect: [...(answers.multiselect ?? [])],
    password: [...(answers.password ?? [])],
  };
  const next = <T>(kind: keyof ScriptedAnswers, message: string): T => {
    asked.push(`${kind}: ${message}`);
    if (remaining[kind].length === 0) throw new Error(`unexpected ${kind} prompt: ${message}`);
    return remaining[kind].shift() as T;
  };
  const port: InitPromptPort = {
    text: async ({ message }) => next("text", message),
    confirm: async ({ message }) => next("confirm", message),
    select: async ({ message }) => next("select", message),
    multiselect: async ({ message }) => next("multiselect", message),
    password: async ({ message }) => next("password", message),
    isCancel: (v: unknown): v is symbol => v === CANCEL,
    note: (m) => { logs.push(`note: ${m}`); },
    log: {
      info: (m) => { logs.push(`info: ${m}`); },
      warn: (m) => { logs.push(`warn: ${m}`); },
      success: (m) => { logs.push(`success: ${m}`); },
    },
  };
  return { port, asked, logs, remaining };
}
