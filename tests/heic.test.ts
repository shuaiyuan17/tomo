import { EventEmitter } from "node:events";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, it, expect, vi } from "vitest";
import { type ChildProcess } from "node:child_process";
import {
  isHeicMimeType, hasHeicExtension, sniffHeic, looksLikeHeic, convertHeicImage, heicHasAlpha,
  SIPS_TIMEOUT_MS, SIPS_PROBE_TIMEOUT_MS,
} from "../src/channels/heic.js";

const spawnMock = vi.fn();
// The mock replaces `spawn` for this whole module graph — including this test
// file — so stash the real one for the integration test at the bottom, which
// needs an actual child process.
const hoisted = vi.hoisted(() => ({
  realSpawn: null as unknown as typeof import("node:child_process").spawn,
  /** When set, every `unlink` inside heic.ts blocks on it. */
  blockUnlink: null as null | Promise<void>,
}));
// heic.ts unlinks its temp output through fs/promises. Gating it is how the
// "settles without waiting for the unlink" test below holds the fs call open.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (path: string) => {
      if (hoisted.blockUnlink) await hoisted.blockUnlink;
      return actual.unlink(path);
    },
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  hoisted.realSpawn = actual.spawn;
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

/** Minimal stand-in for a spawned `sips` child. */
class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  stdout = new EventEmitter();
  /** Signals this child was sent, in order. */
  signals: string[] = [];
  kill(signal?: string) { this.signals.push(signal ?? "SIGTERM"); return true; }
}

/** Pull the `--out <path>` value the code chose out of the spawn args. */
function outPathFromArgs(args: string[]): string {
  const idx = args.indexOf("--out");
  return idx >= 0 ? args[idx + 1] : "";
}

afterEach(() => {
  spawnMock.mockReset();
});

// A real iPhone HEIC header: `....ftypheic....mif1MiHE...` (from a 2026-07-07
// dogfood group photo). Only the leading ftyp box matters for detection.
const HEIC_HEADER = Buffer.from(
  "00000024667479706865696300000000" + "6d696631" + "4d694845" + "6d696166",
  "hex",
);
const JPEG_HEADER = Buffer.from("ffd8ffe000104a464946000101", "hex");
const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
// ftyp box whose brands are all MP4/QuickTime, not HEIF.
const MP4_HEADER = Buffer.from("0000001c667479706d70343200000000" + "6d703432" + "69736f6d", "hex");

describe("HEIC mime detection", () => {
  it("matches the HEIC/HEIF image mime types incl. -sequence", () => {
    expect(isHeicMimeType("image/heic")).toBe(true);
    expect(isHeicMimeType("image/heif")).toBe(true);
    expect(isHeicMimeType("image/heic-sequence")).toBe(true);
    expect(isHeicMimeType("IMAGE/HEIF")).toBe(true);
  });

  it("rejects non-HEIC mimes and junk", () => {
    expect(isHeicMimeType("image/jpeg")).toBe(false);
    expect(isHeicMimeType("image/png")).toBe(false);
    expect(isHeicMimeType(undefined)).toBe(false);
    expect(isHeicMimeType("")).toBe(false);
  });
});

describe("HEIC extension detection", () => {
  it("matches .heic/.heif case-insensitively", () => {
    expect(hasHeicExtension("/a/b/photo.heic")).toBe(true);
    expect(hasHeicExtension("/a/b/PHOTO.HEIF")).toBe(true);
    expect(hasHeicExtension("photo.jpg")).toBe(false);
    expect(hasHeicExtension("photo.heic.jpg")).toBe(false);
  });
});

describe("HEIC magic-byte sniffing", () => {
  it("detects a HEIF ftyp box by major or compatible brand", () => {
    expect(sniffHeic(HEIC_HEADER)).toBe(true);
  });

  it("does not misfire on JPEG, PNG, or MP4 headers", () => {
    expect(sniffHeic(JPEG_HEADER)).toBe(false);
    expect(sniffHeic(PNG_HEADER)).toBe(false);
    expect(sniffHeic(MP4_HEADER)).toBe(false);
    expect(sniffHeic(Buffer.alloc(4))).toBe(false);
  });
});

describe("looksLikeHeic (any signal)", () => {
  it("is true when any of mime / extension / magic bytes indicates HEIC", () => {
    expect(looksLikeHeic("image/heic", "x.jpg", JPEG_HEADER)).toBe(true); // mime
    expect(looksLikeHeic("image/jpeg", "x.heic", JPEG_HEADER)).toBe(true); // extension
    expect(looksLikeHeic("image/jpeg", "x.jpg", HEIC_HEADER)).toBe(true); // magic
    expect(looksLikeHeic("image/jpeg", "x.jpg", JPEG_HEADER)).toBe(false); // none
  });
});

describe("convertHeicImage temp-file cleanup", () => {
  it("unlinks the partial temp output on non-zero sips exit and returns null (no leak)", async () => {
    let capturedOut = "";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      capturedOut = outPathFromArgs(args);
      // sips wrote a partial/corrupt file before failing.
      writeFileSync(capturedOut, Buffer.from("partial"));
      const child = new FakeChild();
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    });

    const result = await convertHeicImage("/tmp/input.heic", "jpeg");

    expect(result).toBeNull();
    expect(capturedOut).not.toBe("");
    // Fire-and-forget by design (see scrubOutput) — assert eventually, not now.
    await vi.waitFor(() => expect(existsSync(capturedOut)).toBe(false));
  });

  it("unlinks the temp output on a spawn error and returns null", async () => {
    let capturedOut = "";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      capturedOut = outPathFromArgs(args);
      writeFileSync(capturedOut, Buffer.from("partial"));
      const child = new FakeChild();
      queueMicrotask(() => child.emit("error", new Error("spawn sips ENOENT")));
      return child;
    });

    const result = await convertHeicImage("/tmp/input.heic", "jpeg");

    expect(result).toBeNull();
    await vi.waitFor(() => expect(existsSync(capturedOut)).toBe(false));
  });

  it("returns null without throwing when no temp file was written (ENOENT tolerated)", async () => {
    let capturedOut = "";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      capturedOut = outPathFromArgs(args);
      const child = new FakeChild(); // never wrote outPath
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    });

    const result = await convertHeicImage("/tmp/input.heic", "jpeg");

    expect(result).toBeNull();
    await vi.waitFor(() => expect(existsSync(capturedOut)).toBe(false));
  });

  it("returns the output path on a successful (code 0) conversion", async () => {
    let capturedOut = "";
    let capturedArgs: string[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      capturedArgs = args;
      capturedOut = outPathFromArgs(args);
      writeFileSync(capturedOut, Buffer.from("ffd8ffe0", "hex"));
      const child = new FakeChild();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });

    const result = await convertHeicImage("/tmp/input.heic", "jpeg");

    expect(result).toBe(capturedOut);
    expect(capturedArgs.slice(0, 3)).toEqual(["-s", "format", "jpeg"]);
    expect(capturedOut).toMatch(/\.jpg$/);
    expect(existsSync(capturedOut)).toBe(true);
    unlinkSync(capturedOut);
  });

  it("targets PNG (format arg and .png output) when asked — the alpha-preserving path", async () => {
    let capturedOut = "";
    let capturedArgs: string[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      capturedArgs = args;
      capturedOut = outPathFromArgs(args);
      writeFileSync(capturedOut, Buffer.from("89504e47", "hex"));
      const child = new FakeChild();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });

    const result = await convertHeicImage("/tmp/sticker.heic", "png");

    expect(result).toBe(capturedOut);
    expect(capturedArgs.slice(0, 3)).toEqual(["-s", "format", "png"]);
    expect(capturedOut).toMatch(/\.png$/);
    unlinkSync(capturedOut);
  });
});

describe("heicHasAlpha probe", () => {
  const probeWith = (stdout: string, exitCode = 0) => {
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", stdout);
        child.emit("exit", exitCode);
      });
      return child;
    });
    return heicHasAlpha("/tmp/input.heic");
  };

  it("parses yes/no from sips -g hasAlpha output", async () => {
    await expect(probeWith("/tmp/input.heic\n  hasAlpha: yes\n")).resolves.toBe(true);
    await expect(probeWith("/tmp/input.heic\n  hasAlpha: no\n")).resolves.toBe(false);
  });

  it("returns null on a non-zero exit, unparseable output, or spawn error", async () => {
    await expect(probeWith("Error: unreadable", 1)).resolves.toBeNull();
    await expect(probeWith("no such property\n")).resolves.toBeNull();
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit("error", new Error("spawn sips ENOENT")));
      return child;
    });
    await expect(heicHasAlpha("/tmp/input.heic")).resolves.toBeNull();
  });

  it("passes the source path to sips -g hasAlpha", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      capturedArgs = args;
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", "hasAlpha: yes");
        child.emit("exit", 0);
      });
      return child;
    });
    await heicHasAlpha("/a/b/sticker.heic");
    expect(capturedArgs).toEqual(["-g", "hasAlpha", "/a/b/sticker.heic"]);
  });
});


describe("sips deadlines (the inbound-FIFO wedge)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves null and escalates SIGTERM → SIGKILL when a conversion overruns", async () => {
    vi.useFakeTimers();
    let child!: FakeChild;
    let capturedOut = "";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      capturedOut = outPathFromArgs(args);
      child = new FakeChild(); // never emits exit/error — a wedged sips
      return child;
    });

    const promise = convertHeicImage("/tmp/hostile.heic", "jpeg");

    // Nothing yet: a slow conversion is still allowed to finish.
    await vi.advanceTimersByTimeAsync(SIPS_TIMEOUT_MS - 1);
    expect(child.signals).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    // The promise settles at the deadline — NOT when the child dies. That
    // ordering is the fix: `watchChain` is a strict FIFO and `quiesce()` is
    // `await this.watchChain`, so a promise that waits for an unkillable
    // child is a permanent inbound stall plus an unkillable daemon.
    await expect(promise).resolves.toBeNull();
    expect(child.signals).toEqual(["SIGTERM"]);

    // SIGTERM ignored → SIGKILL after the grace. This escalation used to be
    // cancelled by the disarm that runs when the promise settles.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);

    await vi.waitFor(() => expect(existsSync(capturedOut)).toBe(false)); // partial output cleaned up
  });

  it("does not signal a conversion that finishes inside the deadline", async () => {
    vi.useFakeTimers();
    let child!: FakeChild;
    let capturedOut = "";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      capturedOut = outPathFromArgs(args);
      writeFileSync(capturedOut, Buffer.from("ffd8ffe0", "hex"));
      child = new FakeChild();
      return child;
    });

    const promise = convertHeicImage("/tmp/input.heic", "jpeg");
    await vi.advanceTimersByTimeAsync(10);
    child.emit("exit", 0);
    await expect(promise).resolves.toBe(capturedOut);

    // Well past the deadline: a disarmed timer must not fire on a child that
    // already exited (and, in the real world, on a recycled pid).
    await vi.advanceTimersByTimeAsync(SIPS_TIMEOUT_MS + 5_000);
    expect(child.signals).toEqual([]);
    unlinkSync(capturedOut);
  });

  it("resolves null and kills the alpha probe when it overruns", async () => {
    vi.useFakeTimers();
    let child!: FakeChild;
    spawnMock.mockImplementation(() => {
      child = new FakeChild();
      return child;
    });

    const promise = heicHasAlpha("/tmp/hostile.heic");
    await vi.advanceTimersByTimeAsync(SIPS_PROBE_TIMEOUT_MS - 1);
    expect(child.signals).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBeNull();
    expect(child.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

/**
 * The property that matters is process semantics — "the await returns even
 * though the child is still alive", and "the child dies anyway". Neither can
 * be observed against a fake child, so this runs against a real one that
 * installs a SIGTERM handler and refuses to die.
 */
describe("convertHeicImage against a real un-SIGTERM-able child", () => {
  const spawned: ChildProcess[] = [];

  afterEach(() => {
    for (const c of spawned) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
    spawned.length = 0;
  });

  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it("settles at the deadline while the child lives, then SIGKILLs it", async () => {
    spawnMock.mockImplementation(() => {
      const c = hoisted.realSpawn(process.execPath, [
        "-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
      ], { stdio: ["ignore", "ignore", "pipe"] });
      spawned.push(c);
      return c;
    });

    const started = Date.now();
    const result = await convertHeicImage("/tmp/hostile.heic", "jpeg", 300);
    const elapsed = Date.now() - started;

    // On unchanged main there is no deadline at all: this await never returns
    // and the test times out.
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(2_000);

    const pid = spawned[0].pid!;
    expect(alive(pid)).toBe(true); // SIGTERM was ignored; we did not wait for it

    // …but the escalation still runs (2s grace) even though the promise is
    // long settled.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(alive(pid)).toBe(false);
  }, 20_000);
});


describe("settling is never behind an fs call", () => {
  afterEach(() => { hoisted.blockUnlink = null; });

  it("resolves without waiting for the temp-file unlink", async () => {
    // The deadline exists to keep the inbound FIFO moving, so nothing
    // unbounded may sit between "deadline reached" and "promise settled".
    // `unlink` is unbounded (it is a syscall on a possibly-wedged filesystem),
    // so it must run AFTER the resolve, not before it.
    let release!: () => void;
    hoisted.blockUnlink = new Promise<void>((r) => { release = r; });

    let capturedOut = "";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      capturedOut = outPathFromArgs(args);
      writeFileSync(capturedOut, Buffer.from("partial"));
      const child = new FakeChild();
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    });

    // Before the fix this awaited the blocked unlink and timed out.
    await expect(convertHeicImage("/tmp/input.heic", "jpeg")).resolves.toBeNull();

    release();
    hoisted.blockUnlink = null;
    await vi.waitFor(() => expect(existsSync(capturedOut)).toBe(false));
  }, 5_000);

  it("scrubs the output again when a killed child exits after the deadline", async () => {
    // The child has up to SIPS_KILL_GRACE_MS still running after we settle, so
    // it can create (or re-create) outPath behind the first scrub.
    vi.useFakeTimers();
    try {
      let child!: FakeChild;
      let capturedOut = "";
      spawnMock.mockImplementation((_cmd: string, args: string[]) => {
        capturedOut = outPathFromArgs(args);
        child = new FakeChild();
        return child;
      });

      const promise = convertHeicImage("/tmp/hostile.heic", "jpeg");
      await vi.advanceTimersByTimeAsync(SIPS_TIMEOUT_MS);
      await expect(promise).resolves.toBeNull();

      // sips writes its partial output only now, after the first scrub ran.
      writeFileSync(capturedOut, Buffer.from("partial written during the grace"));
      child.emit("exit", null);
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(existsSync(capturedOut)).toBe(false));
    } finally {
      vi.useRealTimers();
    }
  });
});
