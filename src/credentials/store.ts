import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonAtomicSync } from "../fs-utils.js";
import { isCredentialName, KEYCHAIN_SERVICE } from "./names.js";

export interface CredentialBackend {
  /** Stores the value, replacing any existing one. */
  put(name: string, value: string): Promise<void>;
  get(name: string): Promise<string | null>;
}

/** Carries no detail: the message can reach the model through a tool result. */
export class CredentialStoreError extends Error {
  constructor() {
    super("credential store is unavailable");
    this.name = "CredentialStoreError";
  }
}

export class MemoryBackend implements CredentialBackend {
  readonly items = new Map<string, string>();
  async put(name: string, value: string): Promise<void> {
    this.items.set(name, value);
  }
  async get(name: string): Promise<string | null> {
    return this.items.get(name) ?? null;
  }
}

const ERR_NOT_FOUND = 44;

/**
 * Values the keychain hands back unchanged from `find-generic-password -w`:
 * printable ASCII. Anything else `security` prints as hex, which the agent's
 * `$(security … -w)` would then pass on as the wrong value, so the broker
 * refuses it at capture.
 */
export function isStorableValue(value: string): boolean {
  return /^[\x20-\x7e]+$/.test(value);
}

/**
 * The login keychain, through `/usr/bin/security`, as a generic password with
 * service `KEYCHAIN_SERVICE` and the credential's name as the account, so the
 * agent reads it with `security find-generic-password -s … -a <name> -w`
 * (`keychainReadCommand`). The value is written over stdin (`security -i`),
 * never argv, where `-w <value>` would show in `ps`; `-X` takes hex, so no value
 * needs quoting. Reading passes only the name in argv.
 */
export class KeychainBackend implements CredentialBackend {
  constructor(private readonly securityPath = "/usr/bin/security") {}

  private run(args: string[], stdin?: string): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.securityPath, args, { stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("error", () => reject(new CredentialStoreError()));
      child.on("close", (code) => resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") }));
      if (stdin !== undefined) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(stdin);
      }
    });
  }

  async put(name: string, value: string): Promise<void> {
    if (!isCredentialName(name) || !isStorableValue(value)) throw new CredentialStoreError();
    const hex = Buffer.from(value, "utf8").toString("hex");
    const { code } = await this.run(["-i", "-p", ""], `add-generic-password -a "${name}" -s "${KEYCHAIN_SERVICE}" -U -X ${hex}\n`);
    if (code !== 0) throw new CredentialStoreError();
  }

  async get(name: string): Promise<string | null> {
    if (!isCredentialName(name)) throw new CredentialStoreError();
    const { code, stdout } = await this.run(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]);
    if (code === ERR_NOT_FOUND) return null;
    const value = stdout.replace(/\r?\n$/, "");
    if (code !== 0 || !isStorableValue(value)) throw new CredentialStoreError();
    return value;
  }
}

export interface PendingRequest {
  /** Random, so the web UI's card can name the request it answers. */
  id: string;
  name: string;
  /** As the agent wrote it, cleaned. Shown to the owner; never a value. */
  purpose: string;
  sessionKey: string;
  /** The channel the request was made on, and the chat it was asked in. */
  channel: string;
  chatId: string;
  expiresAt: number;
}

/** A request that timed out. A message SENT inside it may still be delivered. */
export interface ClosedWindow extends PendingRequest {
  startsAt: number;
}

export interface BrokerState {
  names: string[];
  pending: PendingRequest | null;
  closedWindows: ClosedWindow[];
  /** Ids of messages that carried a credential, so a replay is swallowed and a
   *  later reply or tapback cannot quote one. */
  consumedIds: string[];
}

const MAX_CONSUMED_IDS = 1000;
const MAX_CLOSED_WINDOWS = 20;

function isPending(value: unknown): value is PendingRequest {
  const p = value as Partial<PendingRequest> | null;
  return typeof p?.id === "string" && typeof p.name === "string" && typeof p.purpose === "string"
    && typeof p.sessionKey === "string" && typeof p.channel === "string" && typeof p.chatId === "string"
    && typeof p.expiresAt === "number";
}

/**
 * Names and request state, never values. On disk because losing it is a leak: a
 * restart would otherwise send the owner's reply to the model as a normal message.
 * `load` throws on anything it cannot vouch for, and the broker fails closed.
 */
export class BrokerStateFile {
  constructor(private readonly path: string) {}

  load(): BrokerState {
    if (!existsSync(this.path)) return { names: [], pending: null, closedWindows: [], consumedIds: [] };
    const s = JSON.parse(readFileSync(this.path, "utf8")) as Partial<BrokerState>;
    const valid = s !== null && typeof s === "object"
      && Array.isArray(s.names)
      && Array.isArray(s.consumedIds)
      && Array.isArray(s.closedWindows) && s.closedWindows.every((w) => isPending(w) && typeof w.startsAt === "number")
      && (s.pending === null || isPending(s.pending));
    if (!valid) throw new Error("credential broker state has the wrong shape");
    return s as BrokerState;
  }

  /**
   * For a file `load` refused: the channels it still names a request (open, or
   * closed recently enough that a late reply may be on its way) for, read as
   * loosely as possible. Null when nothing can be read, in which case every
   * chat channel is held. Never throws.
   */
  salvageChannels(now: number, slackMs: number): string[] | null {
    try {
      const s = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown> | null;
      if (!s || typeof s !== "object") return null;
      const channels = new Set<string>();
      const pending = s.pending as Partial<PendingRequest> | null | undefined;
      if (pending !== null && pending !== undefined) {
        if (typeof pending.channel !== "string") return null;
        channels.add(pending.channel);
      }
      if (s.closedWindows !== undefined && !Array.isArray(s.closedWindows)) return null;
      for (const w of (s.closedWindows ?? []) as Array<Partial<ClosedWindow>>) {
        if (typeof w?.expiresAt === "number" && w.expiresAt + slackMs < now) continue;
        if (typeof w?.channel !== "string") return null;
        channels.add(w.channel);
      }
      return [...channels];
    } catch {
      return null;
    }
  }

  save(state: BrokerState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeJsonAtomicSync(this.path, {
      ...state,
      consumedIds: state.consumedIds.slice(-MAX_CONSUMED_IDS),
      closedWindows: state.closedWindows.slice(-MAX_CLOSED_WINDOWS),
    }, { mode: 0o600 });
  }
}
