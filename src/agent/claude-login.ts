import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_URL_RE = /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s]+/;

interface PendingLogin {
  owner: string;
  child: ChildProcessWithoutNullStreams;
  url?: string;
  output: string;
  codeSubmitted: boolean;
  timeout: ReturnType<typeof setTimeout>;
  urlPromise: Promise<string>;
  resolveUrl: (url: string) => void;
  rejectUrl: (err: Error) => void;
  completionPromise: Promise<void>;
  resolveCompletion: () => void;
  rejectCompletion: (err: Error) => void;
}

export interface ClaudeLoginManagerOptions {
  spawnLogin?: () => ChildProcessWithoutNullStreams;
  verifyLogin?: () => Promise<void>;
  timeoutMs?: number;
}

export interface ClaudeLoginStart {
  url: string;
  reused: boolean;
}

/**
 * Owns the single machine-global Claude OAuth flow. The PKCE verifier lives in
 * the waiting `claude auth login` child, so the process must stay alive between
 * sending the URL and receiving the one-time code from the owner.
 */
export class ClaudeLoginManager {
  private pending: PendingLogin | null = null;
  private readonly spawnLogin: () => ChildProcessWithoutNullStreams;
  private readonly verifyLogin: () => Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: ClaudeLoginManagerOptions = {}) {
    this.spawnLogin = options.spawnLogin ?? (() => spawn("claude", ["auth", "login"], {
      stdio: ["pipe", "pipe", "pipe"],
    }));
    this.verifyLogin = options.verifyLogin ?? verifyClaudeLogin;
    this.timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  }

  async start(owner: string): Promise<ClaudeLoginStart> {
    const normalizedOwner = owner.toLowerCase();
    if (this.pending) {
      if (this.pending.owner !== normalizedOwner) {
        throw new Error("Another owner already has a Claude login in progress");
      }
      return {
        url: this.pending.url ?? await this.pending.urlPromise,
        reused: true,
      };
    }

    const child = this.spawnLogin();
    let resolveUrl!: (url: string) => void;
    let rejectUrl!: (err: Error) => void;
    const urlPromise = new Promise<string>((resolve, reject) => {
      resolveUrl = resolve;
      rejectUrl = reject;
    });
    let resolveCompletion!: () => void;
    let rejectCompletion!: (err: Error) => void;
    const completionPromise = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // A child can fail before `/login <code>` attaches its await. Keep that
    // rejection observed while preserving it for the eventual caller.
    void completionPromise.catch(() => {});

    const pending: PendingLogin = {
      owner: normalizedOwner,
      child,
      output: "",
      codeSubmitted: false,
      timeout: setTimeout(() => {
        const err = new Error("Claude login expired after 10 minutes; run /login again");
        rejectUrl(err);
        rejectCompletion(err);
        child.kill();
        this.clearPending(pending);
      }, this.timeoutMs),
      urlPromise,
      resolveUrl,
      rejectUrl,
      completionPromise,
      resolveCompletion,
      rejectCompletion,
    };
    this.pending = pending;

    const capture = (chunk: Buffer | string): void => {
      pending.output = (pending.output + chunk.toString()).slice(-16_000);
      if (pending.url) return;
      const match = LOGIN_URL_RE.exec(pending.output);
      if (match) {
        pending.url = match[0];
        pending.resolveUrl(match[0]);
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.stdin.on("error", (err) => {
      pending.rejectCompletion(new Error(`Could not submit Claude login code: ${err.message}`));
    });

    child.once("error", (err) => {
      pending.rejectUrl(new Error(`Could not start Claude login: ${err.message}`));
      pending.rejectCompletion(err);
      this.clearPending(pending);
    });
    child.once("exit", (code, signal) => {
      // Exit 0 after a submitted code means the CLI accepted the exchange. The
      // separate authenticated probe below is the authoritative verification.
      if (code === 0 && pending.codeSubmitted) {
        pending.resolveCompletion();
      } else {
        const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
        const err = new Error(`Claude login did not complete (${reason})`);
        pending.rejectUrl(err);
        pending.rejectCompletion(err);
      }
      this.clearPending(pending);
    });

    return { url: await urlPromise, reused: false };
  }

  async complete(owner: string, code: string): Promise<void> {
    const pending = this.pending;
    if (!pending) throw new Error("No Claude login is waiting; send /login first");
    if (pending.owner !== owner.toLowerCase()) {
      throw new Error("This Claude login belongs to another owner");
    }
    if (pending.codeSubmitted) throw new Error("That Claude login code is already being verified");

    const trimmed = code.trim();
    const hash = trimmed.lastIndexOf("#");
    if (hash <= 0 || hash === trimmed.length - 1 || /\s/.test(trimmed)) {
      throw new Error("Invalid authorization code; paste the complete code returned by Claude");
    }
    const expectedState = pending.url ? new URL(pending.url).searchParams.get("state") : null;
    const receivedState = trimmed.slice(hash + 1);
    if (!expectedState || receivedState !== expectedState) {
      throw new Error("Authorization code does not match the active /login request");
    }

    pending.codeSubmitted = true;
    pending.child.stdin.end(`${trimmed}\n`);
    await pending.completionPromise;
    await this.verifyLogin();
  }

  cancel(owner: string): boolean {
    const pending = this.pending;
    if (!pending || pending.owner !== owner.toLowerCase()) return false;
    const err = new Error("Claude login cancelled");
    pending.rejectUrl(err);
    pending.rejectCompletion(err);
    pending.child.kill();
    this.clearPending(pending);
    return true;
  }

  stop(): void {
    const pending = this.pending;
    if (!pending) return;
    const err = new Error("Tomo stopped during Claude login");
    pending.rejectUrl(err);
    pending.rejectCompletion(err);
    pending.child.kill();
    this.clearPending(pending);
  }

  private clearPending(pending: PendingLogin): void {
    clearTimeout(pending.timeout);
    if (this.pending === pending) this.pending = null;
  }
}

function verifyClaudeLogin(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "claude",
      ["-p", "Reply with exactly OK.", "--safe-mode", "--no-session-persistence", "--tools", ""],
      { timeout: 60_000 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve();
          return;
        }
        const detail = `${stderr || stdout}`.trim().split("\n")[0]?.slice(0, 300);
        reject(new Error(`Claude login verification failed${detail ? `: ${detail}` : ""}`));
      },
    );
  });
}
