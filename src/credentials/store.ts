import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonAtomicSync } from "../fs-utils.js";

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

const SERVICE = "tomo-credential-broker";
/** Stored values are `tomo1:<base64>`, so `-w` prints them as is and the marker
 *  can be found in the output however the interactive prompt behaves. */
const VALUE_RE = /tomo1:([A-Za-z0-9+/=]+)/;
const ERR_NOT_FOUND = 44;

/**
 * The login keychain, through `/usr/bin/security`. Commands go over stdin
 * (`security -i`), never argv, where `-w <value>` would show in `ps`. `-X` takes
 * hex, so no value needs quoting.
 */
export class KeychainBackend implements CredentialBackend {
  constructor(private readonly securityPath = "/usr/bin/security") {}

  private run(command: string): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.securityPath, ["-i", "-p", ""], { stdio: ["pipe", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("error", () => reject(new CredentialStoreError()));
      child.on("close", (code) => resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") }));
      child.stdin.on("error", () => {});
      child.stdin.end(`${command}\n`);
    });
  }

  async put(name: string, value: string): Promise<void> {
    const stored = `tomo1:${Buffer.from(value, "utf8").toString("base64")}`;
    const hex = Buffer.from(stored, "utf8").toString("hex");
    const { code } = await this.run(`add-generic-password -a "${name}" -s "${SERVICE}" -U -X ${hex}`);
    if (code !== 0) throw new CredentialStoreError();
  }

  async get(name: string): Promise<string | null> {
    const { code, stdout } = await this.run(`find-generic-password -a "${name}" -s "${SERVICE}" -w`);
    if (code === ERR_NOT_FOUND) return null;
    const match = code === 0 ? VALUE_RE.exec(stdout) : null;
    if (!match) throw new CredentialStoreError();
    return Buffer.from(match[1], "base64").toString("utf8");
  }
}

export interface PendingRequest {
  name: string;
  sessionKey: string;
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
  return typeof p?.name === "string" && typeof p.sessionKey === "string" && typeof p.expiresAt === "number";
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
    const valid = Array.isArray(s.names)
      && Array.isArray(s.consumedIds)
      && Array.isArray(s.closedWindows)
      && (s.pending === null || isPending(s.pending));
    if (!valid) throw new Error("credential broker state has the wrong shape");
    return s as BrokerState;
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
