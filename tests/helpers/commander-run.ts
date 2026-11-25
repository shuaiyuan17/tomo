import { vi } from "vitest";
import type { Command } from "commander";

/** What one in-process run of a CLI command printed, and how it exited. */
export interface CommandRun {
  /** The code passed to `process.exit`, or 0 when the action just returned. */
  code: number;
  /** Everything `console.log` printed, one line per call, as stdout would hold it. */
  out: string;
  /** Everything `console.error` printed, the same way. */
  err: string;
}

const EXIT = Symbol("process.exit");

/**
 * Run a commander command in this process, as `tomo <name> <args...>` would.
 *
 * Spawning `tsx src/cli.ts` per assertion costs about a second each (it
 * compiles the whole CLI), and the action code is the same either way. Output
 * is captured from `console.log` / `console.error`, which is all these
 * commands write with. A real `process.exit` would take the test runner with
 * it, so it throws instead — that reproduces its control flow: nothing after
 * the call runs. Commander restores its option state before every parse, so
 * one exported command can be run many times in a file.
 *
 * Keep one or two real spawns per command as smoke tests for the wiring (that
 * `src/cli.ts` registers it, and that nothing else reaches stdout).
 */
export async function runCommand(command: Command, args: string[]): Promise<CommandRun> {
  const out: string[] = [];
  const err: string[] = [];
  let code = 0;
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(`${a.join(" ")}\n`); });
  const error = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(`${a.join(" ")}\n`); });
  const exit = vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
    code = c ?? 0;
    throw EXIT;
  }) as never);
  try {
    await command.parseAsync(args, { from: "user" });
  } catch (thrown) {
    if (thrown !== EXIT) throw thrown;
  } finally {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
  return { code, out: out.join(""), err: err.join("") };
}
