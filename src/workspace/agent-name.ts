import { closeSync, fstatSync, openSync, readSync, constants } from "node:fs";
import { join } from "node:path";

/** What the agent is called when nothing names it: the product's own name. */
export const DEFAULT_AGENT_NAME = "Tomo";
/** Longest name shown; anything longer is not a name line. */
export const MAX_AGENT_NAME = 64;
/** IDENTITY.md is a few hundred bytes; only its head is read. */
const IDENTITY_HEAD_BYTES = 16 * 1024;

/** Markdown emphasis, code and links reduced to their text. */
function plain(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`|~~)(.+?)\1/g, "$2")
    .replace(/[*_`]/g, "")
    .trim();
}

/**
 * The agent's name from IDENTITY.md: its first `Name:` line, as `tomo init`
 * writes it (`- **Name:** Claw`) or plainer (`Name: Claw`, `**Name**: Claw`,
 * `名字：克劳`). Emphasis is dropped; a trailing note (`Claw (he/him)`,
 * `Claw — picked 2026-04`) is not part of the name. Undefined when no line
 * names one.
 */
export function parseIdentityName(markdown: string): string | undefined {
  for (const raw of markdown.split(/\r?\n/)) {
    const line = plain(raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""));
    const match = /^(?:name|名字|名称|姓名)\s*[:：]\s*(.+)$/i.exec(line);
    if (!match) continue;
    const name = match[1].split(/\s+[—–-]\s+|\s*[(（]/)[0].trim().replace(/[.,;。，；]+$/, "");
    if (name && name.length <= MAX_AGENT_NAME && !/[<>\n]/.test(name)) return name;
  }
  return undefined;
}

/**
 * The agent's name: `agent.name` from config when set; else IDENTITY.md's
 * Name line; else "Tomo". IDENTITY.md is re-read whenever its mtime or size
 * changes, so an edit shows on the next read without a restart.
 */
export class AgentNameReader {
  private cache?: { key: string; name: string | undefined };
  constructor(private readonly options: { configured?: string | null; workspaceDir?: string }) {}

  name(): string {
    const configured = this.options.configured?.trim();
    if (configured) return configured.slice(0, MAX_AGENT_NAME);
    return this.fromIdentity() ?? DEFAULT_AGENT_NAME;
  }

  private fromIdentity(): string | undefined {
    if (!this.options.workspaceDir) return undefined;
    let fd: number | undefined;
    try {
      fd = openSync(join(this.options.workspaceDir, "IDENTITY.md"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) return undefined;
      const key = `${stat.mtimeMs}:${stat.size}`;
      if (this.cache?.key === key) return this.cache.name;
      const buffer = Buffer.alloc(Math.min(stat.size, IDENTITY_HEAD_BYTES));
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      const name = parseIdentityName(buffer.subarray(0, read).toString("utf8"));
      this.cache = { key, name };
      return name;
    } catch { return undefined; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}
