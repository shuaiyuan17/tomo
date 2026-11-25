/**
 * `sandbox-exec` presence for the sandbox tests.
 *
 * CI runs on Linux, which has neither `/usr/bin/sandbox-exec` nor `/bin/zsh`.
 * `sandboxedBashCommand` checks both with `existsSync` before anything else, so
 * on Linux every "returns null when …" test, and every guard assertion about the
 * profile text, used to stop at that first check and pass whatever the branch it
 * named did. Two separate things are therefore needed:
 *
 *  - `sandboxRuns`: is the sandbox REALLY here (macOS with both binaries)? Only
 *    a test that EXECUTES the wrapped command gates on it.
 *  - a pretend presence for everything else: the `node:fs` mock below answers
 *    `existsSync` from `sandboxPresence` first, so a test can make both binaries
 *    "exist" and reach the resolver, the hook scan and the profile builder on
 *    any host. Nothing that runs the command may rely on the pretence.
 *
 * Use it from a test file as
 *
 *     vi.mock("node:fs", async (importOriginal) =>
 *       (await import("./helpers/sandbox-exec.js")).fsWithSandboxPresence(await importOriginal()));
 *
 * This module must not import `node:fs` itself: in a file that mocks it, that
 * import would be the mock, which is being built from this module. The real
 * module comes through `createRequire`, which vitest's ESM mocks do not touch.
 */
import { createRequire } from "node:module";

const realFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");

/** Paths `existsSync` should pretend are absent (wins) or present. Cleared by
 *  `reset()`, which a file's top-level `beforeEach` should call. */
export const sandboxPresence = {
  missing: new Set<string>(),
  present: new Set<string>(),
  /** Pretend `sandbox-exec` and its shell are installed. */
  pretend(execPath: string, shellPath: string): void {
    sandboxPresence.present.add(execPath);
    sandboxPresence.present.add(shellPath);
  },
  reset(): void {
    sandboxPresence.missing.clear();
    sandboxPresence.present.clear();
  },
};

/** The real `node:fs` with `existsSync` consulting `sandboxPresence`. */
export function fsWithSandboxPresence(actual: typeof import("node:fs")): typeof import("node:fs") {
  const existsSync = ((p: Parameters<typeof actual.existsSync>[0]) => {
    const key = String(p);
    if (sandboxPresence.missing.has(key)) return false;
    return sandboxPresence.present.has(key) || actual.existsSync(p);
  }) as typeof actual.existsSync;
  return { ...actual, default: { ...actual, existsSync }, existsSync } as typeof import("node:fs");
}

/** Whether the kernel sandbox really runs here. Reads the real filesystem, never
 *  the pretence, so a test gated on it really executes under `sandbox-exec`. */
export function sandboxRunsHere(execPath: string, shellPath: string): boolean {
  return process.platform === "darwin" && realFs.existsSync(execPath) && realFs.existsSync(shellPath);
}
