import { Readable } from "node:stream";
import type { Command } from "commander";
import { vi } from "vitest";

/**
 * Drive the real `tomo backup` commander command in-process.
 *
 * The backup tests each mock `node:os`, `src/config.js` and
 * `src/runtime-paths.js` to a temp home themselves (inline, so the hermeticity
 * of every file is visible where it is set up); this is the part they shared
 * verbatim: fake stdin, a sink for the confirmation prompt, captured console
 * output, and `process.exit` turned into a throw.
 */

export interface BackupRun {
  logs: string[];
  errors: string[];
  exitCodes: number[];
  /** What `confirm()` wrote, so a test can see the question was asked. */
  prompts: string;
}

/** Collects what `confirm()` writes, so the prompt does not land in the
 *  middle of `npm test`'s own output. */
export function promptSink(): { stream: NodeJS.WritableStream; text: () => string } {
  let text = "";
  const stream = { write: (chunk: string | Uint8Array) => { text += String(chunk); return true; } };
  return { stream: stream as unknown as NodeJS.WritableStream, text: () => text };
}

const EXIT_SENTINEL = "__exit__";

/**
 * Run `backup <argv…>` and report what it printed.
 *
 * `answer` becomes stdin for `confirm()`. It may be an async generator, which
 * is how a swap-during-prompt case runs its mutation at the one moment that
 * matters: `Readable.from` pulls lazily, so the generator body does not run
 * until readline actually reads — i.e. after the prompt is pending.
 *
 * A `process.exit` call ends the run (its code lands in `exitCodes`); anything
 * else the command throws is rethrown, so a crash can never pass for a clean
 * run. stdin, the prompt stream and the console/exit spies are all put back
 * before this returns or throws.
 */
export async function runBackupCommand(
  command: Command,
  setPromptOutput: (stream: NodeJS.WritableStream) => NodeJS.WritableStream,
  argv: string[],
  answer: Iterable<string> | AsyncIterable<string> = ["y\n"],
): Promise<BackupRun> {
  const originalStdin = process.stdin;
  Object.defineProperty(process, "stdin", { value: Readable.from(answer) as unknown as NodeJS.ReadStream, configurable: true });
  const sink = promptSink();
  const originalPrompt = setPromptOutput(sink.stream);

  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const spies = [
    vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); }),
    vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); }),
    // Real process.exit would take the test runner with it. Throwing
    // reproduces its control flow: nothing after the call runs.
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCodes.push(code ?? 0);
      throw new Error(EXIT_SENTINEL);
    }) as never),
  ];

  try {
    await command.parseAsync(argv, { from: "user" });
  } catch (err) {
    if ((err as Error).message !== EXIT_SENTINEL) throw err;
  } finally {
    for (const spy of spies) spy.mockRestore();
    setPromptOutput(originalPrompt);
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
  }
  return { logs, errors, exitCodes, prompts: sink.text() };
}
