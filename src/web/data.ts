import { constants, statSync } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { basename, extname, join, sep } from "node:path";
import { ownerBindings, ownerDisplayName, ownerSessionKey, OWNER_CHANNELS, type OwnerConfig } from "../owner.js";
import { SessionStore } from "../sessions/store.js";
import { readHistoryPage, HistoryReadError } from "../sessions/history-reader.js";
import { isGroupSessionKey, legacySessionKeysForBinding, normalizeImessageHandle, parseRawSessionKey, taskIdFromSessionKey } from "../sessions/keys.js";
import { readSubsessionTitles } from "../agent/subsessions/store.js";
import { webSessionId } from "./owner.js";
import { isImageFiledFor } from "../channels/imageStore.js";
import { sniffImageType } from "./image-type.js";
import { OutgoingMediaStore, outgoingImagesDir } from "./outgoing-media.js";
export { sniffImageType };
import { WebError, type SessionTools, type SubagentBrief, type SubagentPage, type WebCatalog, type WebContext, type WebTodos } from "./protocol.js";
import { readWebTodos } from "./todos-view.js";
import { todosDirIn } from "../todos/store.js";
import type { TodoConfig } from "../todos/limits.js";
import { readSessionContext, WebCron } from "./inspection.js";
import { WebConfigReader } from "./config-view.js";
import { MemoryReader } from "../workspace/memory-reader.js";
import { AgentNameReader } from "../workspace/agent-name.js";
import { readSubagentBrief, readSubagentModel, readSubagentPage, SubagentReadError } from "./subagent-reader.js";
import { readSessionTools, SessionToolsError } from "./session-tools.js";
import { readHomeAsset } from "../home/files.js";
import { LedgerReader } from "../usage/ledger-reader.js";
import { buildCostReport, DEFAULT_RANGE_DAYS, MAX_RANGE_DAYS, type SessionLabel } from "../usage/cost-report.js";
import { addDays, daysBetween, isCalendarDate, localParts, systemTimeZone } from "../usage/local-time.js";
import { usageDataDir } from "../usage/dir.js";
import { readLatestLimitSample } from "../usage/limits-log.js";
import { findPersonByName, loadPeople, personTimeZone } from "../people.js";
import type { WebCost } from "./protocol.js";
import type { Locale } from "../i18n/locales.js";

export interface WebDataOptions {
  sessionsDir: string;
  sdkSessionsDir: string;
  /** The owner (the web UI always means the owner); undefined = setup required. */
  owner?: OwnerConfig;
  /** The workspace whose public memory the Study browses (never memory/private/). */
  workspaceDir?: string;
  /** Runtime home holding config.json (Study config / MCP view). */
  tomoHome?: string;
  /** `agent.name` from config (null/undefined: read IDENTITY.md in workspaceDir). */
  agentName?: string | null;
  /** `locale` from config: the web UI's default language (null/undefined: the browser's). */
  locale?: Locale | null;
  /** The scheduler's cron store file, passed by the daemon (the web process never derives it). */
  cronDbPath?: string;
  /** The todo limits in force (config `todos`), passed by the daemon; absent: the defaults. */
  todoLimits?: Pick<TodoConfig, "maxOpen" | "maxSnoozes">;
}

/**
 * Which session key the browser shows as the owner conversation: the
 * canonical `dm:<owner>` key when it exists; otherwise a single legacy
 * per-channel DM key bound to the owner; none when several legacy keys match
 * (ambiguous). Everything that exposes owner-session data to the browser —
 * the catalog here and the task panel in channels/web.ts — must use this one
 * rule, or a session the catalog hides could leak through another path.
 */
export function selectOwnerSessionKey(owner: OwnerConfig | undefined, keys: readonly string[]): string | undefined {
  if (!owner) return undefined;
  const canonical = ownerSessionKey(owner);
  if (keys.includes(canonical)) return canonical;
  const legacy = [...new Set(OWNER_CHANNELS.flatMap((channel) =>
    ownerBindings(owner, channel).flatMap((bound) => legacySessionKeysForBinding(keys, channel, bound))))];
  if (legacy.length > 1) return undefined;
  return legacy[0] ?? canonical;
}

/**
 * The active registry keys, re-read only when the registry FILE changed.
 *
 * The web task gate asks for the owner key once a second while a DM task is
 * on the board, and a fresh `readSnapshot` is a whole read and JSON parse of
 * `_sessions.json` each time. Keyed on inode, size, mtime and ctime (ns): the
 * registry is published by atomic rename, so every write is a new inode, and
 * a permission change moves ctime — so a change is still seen by the very
 * next call, exactly as with no cache. Only a successful read is remembered;
 * a missing or unreadable file goes the uncached way every time (fails closed).
 */
function registryKeysReader(options: WebDataOptions): () => string[] {
  const file = SessionStore.registryFile(options.sessionsDir);
  let cached: { signature: string; keys: string[] } | undefined;
  return () => {
    let signature: string | undefined;
    try {
      const st = statSync(file, { bigint: true });
      signature = `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    } catch { signature = undefined; }
    if (signature !== undefined && cached?.signature === signature) return [...cached.keys];
    cached = undefined;
    const keys = SessionStore.readSnapshot(options.sessionsDir, options.sdkSessionsDir).map((e) => e.channelKey);
    if (signature !== undefined) cached = { signature, keys: [...keys] };
    return keys;
  };
}

/**
 * Reads the owner key from the session registry on every call — re-parsed
 * only when the file changed (see registryKeysReader), so a registry change
 * is still honoured by the very next task event (fails closed).
 */
export function ownerSessionKeyReader(options: WebDataOptions): () => string | undefined {
  const keys = registryKeysReader(options);
  return () => {
    try {
      return selectOwnerSessionKey(options.owner, keys());
    } catch { return undefined; }
  };
}

/** Every key in the session registry, current on each call (daemon side; unreadable reads as none). */
export function sessionKeysReader(options: WebDataOptions): () => string[] {
  const keys = registryKeysReader(options);
  return () => {
    try { return keys(); }
    catch { return []; }
  };
}

/** The model of a session key's subagent, from its transcript (daemon side; never throws). */
export function subagentModelReader(options: WebDataOptions): (sessionKey: string, taskId: string) => Promise<string | undefined> {
  return async (sessionKey, taskId) => {
    try {
      const entry = SessionStore.readSnapshot(options.sessionsDir, options.sdkSessionsDir)
        .find((e) => e.channelKey === sessionKey && e.sdkSessionId);
      return entry ? await readSubagentModel(options.sdkSessionsDir, entry.sdkSessionId, taskId) : undefined;
    } catch { return undefined; }
  };
}

/** Image types the browser may be sent, by extension; the file's signature must agree. */
const MEDIA_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic" };
export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
/** Messaging channels whose inbound images the store files (never "web"). */
const INBOUND_CHANNELS = new Set(["telegram", "imessage", "web"]);
/** The meta.sessionKey the web channel files the owner's uploads under. */
export const WEB_IMAGE_KEY = "web_owner";
/** Most images taken from one message (the UI shows "+N more" past this). */
export const MAX_MESSAGE_IMAGES = 20;

/**
 * The meta.sessionKey values the channels file a session's inbound images
 * under (telegram.ts: `telegram_<chatId>`; imsg: `imessage_<chatGuid>`).
 * The owner's DM spans their bound chats: a Telegram id, or an iMessage
 * handle inside a `<service>;-;<handle>` chat GUID.
 */
export function imageSessionKeys(key: string, owner: OwnerConfig | undefined, isOwnerSession: boolean): string[] {
  const raw = parseRawSessionKey(key);
  const keys = raw ? [`${raw.channelName}_${raw.chatId}`] : [];
  if (isOwnerSession && owner) {
    for (const id of ownerBindings(owner, "telegram")) keys.push(`telegram_${id}`);
    // A chat GUID can carry the handle in any of its written forms; the
    // binding is reduced with the shared normaliser (#480) and each form it
    // stands for is tried: +E.164, bare digits, tel: URI; emails as written
    // and lowercased.
    for (const handle of ownerBindings(owner, "imessage")) {
      const normal = normalizeImessageHandle(handle);
      const forms = new Set([handle, normal, ...(normal.startsWith("+") ? [normal.slice(1), `tel:${normal}`] : [])]);
      for (const form of forms) for (const service of ["any", "iMessage", "SMS", "RCS"]) keys.push(`imessage_${service};-;${form}`);
    }
  }
  return keys;
}

/**
 * Paths named by the image/sticker markers at the START of a message — where
 * the channel layer puts them (other markers may come first) — capped at
 * MAX_MESSAGE_IMAGES. See channels/imageStore.ts.
 */
export function imagePaths(content: string): string[] {
  const out: string[] = [];
  const lead = /^(?:\s*\[[^\]]*\])*/.exec(content)?.[0] ?? "";
  for (const match of lead.matchAll(/\[Sent (?:an image|a sticker|\d+ images|\d+ stickers), saved to:? ([^;\]]+)/g)) {
    for (const path of match[1].split(/,\s+/)) if (path.trim().startsWith("/") && out.length < MAX_MESSAGE_IMAGES) out.push(path.trim());
  }
  return out;
}

/** Runs in the web process. Never imports the live Agent or starts services. */
export class WebData {
  readonly memory?: MemoryReader;
  readonly cron: WebCron;
  readonly config?: WebConfigReader;
  private readonly outgoing: OutgoingMediaStore;
  private readonly agent: AgentNameReader;
  constructor(private readonly options: WebDataOptions) {
    this.outgoing = new OutgoingMediaStore(options.workspaceDir ? outgoingImagesDir(options.workspaceDir) : undefined);
    this.agent = new AgentNameReader({ configured: options.agentName, workspaceDir: options.workspaceDir });
    if (options.workspaceDir) this.memory = new MemoryReader(options.workspaceDir);
    if (options.tomoHome) this.config = new WebConfigReader(options.tomoHome);
    this.cron = new WebCron(options.cronDbPath);
  }

  private ledger?: LedgerReader;

  /**
   * The owner's clock, whose midnights split the Cost page's days: the
   * owner's people record (public memory only — the web process never reads
   * memory/private), else this machine's zone. Read per request: a record
   * edited because he travelled moves the days at once.
   */
  ownerTimeZone(): string {
    const { owner, workspaceDir } = this.options;
    if (owner && workspaceDir) {
      try {
        const people = loadPeople({ includePrivate: false, dirs: { publicDir: join(workspaceDir, "memory", "people"), privateDir: join(workspaceDir, "memory", "private", "people") } });
        const zone = personTimeZone(findPersonByName(people, owner.name) ?? (owner.displayName ? findPersonByName(people, owner.displayName) : undefined));
        if (zone) return zone;
      } catch { /* fall back */ }
    }
    return systemTimeZone();
  }

  /** Fill the ledger cache with the last 13 month files (the default view and its year); never throws. */
  warmCost(): void {
    if (!this.options.tomoHome) return;
    try {
      this.ledger ??= new LedgerReader(usageDataDir(this.options.tomoHome));
      this.ledger.rows(this.ledger.files().slice(-13));
    } catch { /* the first request reads instead */ }
  }

  /**
   * The Study Cost page for local dates `from`–`to` (inclusive; default the
   * last 30 days). Reads the usage ledger through a per-file cache (see
   * LedgerReader), so a repeat request reads only rows appended since.
   */
  cost(query: { from?: string | null; to?: string | null; top?: string | null }, now = Date.now()): WebCost {
    if (!this.options.tomoHome) throw new WebError(503, "cost_unavailable");
    const timeZone = this.ownerTimeZone();
    const today = localParts(now, timeZone).date;
    const to = query.to ?? today;
    const from = query.from ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));
    if (!isCalendarDate(from) || !isCalendarDate(to)) throw new WebError(400, "invalid_range");
    const span = daysBetween(from, to) + 1;
    if (span < 1 || span > MAX_RANGE_DAYS) throw new WebError(400, "invalid_range");
    let top: number | undefined;
    if (query.top !== undefined && query.top !== null) {
      if (!/^\d{1,2}$/.test(query.top)) throw new WebError(400, "invalid_range");
      top = Number(query.top);
    }
    const dir = usageDataDir(this.options.tomoHome);
    this.ledger ??= new LedgerReader(dir);
    const catalog = this.catalog();
    const idByKey = new Map([...catalog.keys].map(([id, key]) => [key, id]));
    const entries = new Map(SessionStore.readSnapshot(this.options.sessionsDir, this.options.sdkSessionsDir).map((e) => [e.channelKey, e]));
    const owner = this.options.owner;
    const labels = new Map<string, SessionLabel>();
    let taskTitles: Map<string, string> | undefined;
    const taskTitle = (id: string): string | undefined => {
      // Read once per report, read-only (a consistent snapshot of the
      // database, never an import), and best-effort: a cost page must not
      // fail because the task table is not there.
      taskTitles ??= readSubsessionTitles(this.options.cronDbPath ?? join(this.options.tomoHome!, "data", "tomo.db"));
      return taskTitles.get(id);
    };
    const describeSession = (key: string): SessionLabel => {
      let label = labels.get(key);
      if (label) return label;
      const id = idByKey.get(key);
      const group = isGroupSessionKey(key);
      const taskId = taskIdFromSessionKey(key);
      if (taskId) {
        const title = taskTitle(taskId);
        label = { label: title ? `${taskId} · ${title}` : taskId, kind: "task" };
      } else if (id && id === catalog.ownerId) label = { id, label: owner ? `${ownerDisplayName(owner)} (DM)` : "Owner conversation", kind: "dm" };
      else if (group) label = { ...(id ? { id } : {}), label: entries.get(key)?.chatTitle || "Group conversation", kind: "group" };
      else label = { label: entries.get(key)?.chatTitle || "Other conversation", kind: "other" };
      labels.set(key, label);
      return label;
    };
    const sample = readLatestLimitSample(join(dir, "limits.ndjson"));
    const limits = sample ? {
      sampledAt: sample.ts, source: sample.source,
      windows: sample.windows.map(({ window, label, group, scoped, percent, resetsAt, status }) =>
        ({ window, label, group, scoped, percent, resetsAt, status })),
    } : null;
    return buildCostReport(this.ledger, { from, to, timeZone, now, top, describeSession, limits });
  }

  /**
   * The Study Todos page: the todo store, read and never written. Scoped to
   * what the owner's own conversation sees (see `readWebTodos`).
   */
  todos(): Promise<WebTodos> {
    const { tomoHome, owner, todoLimits } = this.options;
    if (!tomoHome) return Promise.reject(new WebError(503, "todos_unavailable"));
    const titles = new Map(SessionStore.readSnapshot(this.options.sessionsDir, this.options.sdkSessionsDir).map((e) => [e.channelKey, e.chatTitle]));
    return readWebTodos({
      dir: todosDirIn(tomoHome), limits: todoLimits,
      ownerKey: owner ? ownerSessionKey(owner) : undefined,
      groupTitle: (key) => titles.get(key) || "Group conversation",
    });
  }

  /** What the UI calls the agent (re-read per call; IDENTITY.md is cached by mtime). */
  agentName(): string { return this.agent.name(); }
  /** The configured locale, if any (the browser falls back to its own language). */
  locale(): Locale | undefined { return this.options.locale ?? undefined; }

  /** Context usage, estimated breakdown and rollups of a session the catalog shows. */
  async context(id: string): Promise<WebContext> {
    const key = this.catalog().keys.get(id);
    if (!key) throw new WebError(404, "session_not_found");
    const entry = SessionStore.readSnapshot(this.options.sessionsDir, this.options.sdkSessionsDir).find((item) => item.channelKey === key);
    return readSessionContext(entry, this.options.sdkSessionsDir);
  }

  catalog(): WebCatalog & { keys: Map<string, string> } {
    const entries = SessionStore.readSnapshot(this.options.sessionsDir, this.options.sdkSessionsDir);
    const owner = this.options.owner;
    const stableOwnerId = owner ? webSessionId(ownerSessionKey(owner)) : null;
    const ownerKey = selectOwnerSessionKey(owner, entries.map((e) => e.channelKey));
    const keys = new Map<string, string>();
    const sessions: WebCatalog["sessions"] = [];
    // The owner's conversation goes by the owner's name (`displayName`, else `name`).
    const ownerTitle = owner ? ownerDisplayName(owner) : "Owner conversation";
    for (const entry of entries) {
      const group = isGroupSessionKey(entry.channelKey);
      if (!group && entry.channelKey !== ownerKey) continue;
      const id = group ? webSessionId(entry.channelKey) : stableOwnerId!;
      keys.set(id, entry.channelKey);
      sessions.push({ id, title: group ? entry.chatTitle || "Group conversation" : ownerTitle,
        kind: group ? "group" : "dm", writable: !group,
        lastActiveAt: entry.lastActiveAt,
        stats: { contextUsed: entry.stats?.contextUsed ?? 0, contextMax: entry.stats?.contextMax ?? 0,
          contextEstimated: entry.stats?.contextEstimated } });
    }
    if (ownerKey && !keys.has(stableOwnerId!)) {
      const id = stableOwnerId!;
      keys.set(id, ownerKey);
      sessions.unshift({ id, title: ownerTitle, kind: "dm", writable: true,
        lastActiveAt: null, stats: { contextUsed: 0, contextMax: 0 } });
    }
    return { sessions, keys, ownerId: ownerKey ? stableOwnerId : null, setupRequired: !ownerKey };
  }

  /**
   * A page of a subagent's transcript. `sessionKey` comes from the daemon's
   * task gate (the task is on the board the browser was shown); the SDK
   * session is the key's current one in the registry.
   */
  async subagent(sessionKey: string, taskId: string, cursor: { before?: number; after?: number }): Promise<SubagentPage> {
    const entry = SessionStore.readSnapshot(this.options.sessionsDir, this.options.sdkSessionsDir)
      .find((e) => e.channelKey === sessionKey && e.sdkSessionId);
    if (!entry) throw new WebError(404, "transcript_not_found");
    try { return await readSubagentPage(this.options.sdkSessionsDir, entry.sdkSessionId, taskId, cursor); }
    catch (error) {
      if (error instanceof SubagentReadError) throw new WebError(
        error.code === "invalid_cursor" ? 400 : error.code === "transcript_reset" ? 409 : 404, error.code);
      throw error;
    }
  }

  /**
   * Images the browser may load, per session: only paths named by an image
   * marker in a history page this process served for that session.
   */
  private media = new Map<string, Set<string>>();

  /**
   * An inbound image for display, by the absolute path its marker names.
   * Allowed only if (1) the session is visible, (2) a served history page of
   * that session named the path, (3) its real path (symlinks resolved) is
   * under <workspace>/memory/incoming-images and not under memory/private,
   * (4) it is an image type the browser renders, at most MAX_MEDIA_BYTES.
   */
  async mediaFile(id: string, path: string): Promise<{ type: string; bytes: Buffer }> {
    const refuse = () => new WebError(404, "media_not_found");
    // Named by a served history page — or, in the owner's conversation, one
    // of the owner's own browser uploads (an interrupted request's bubble
    // shows them before any history names them).
    const named = this.media.get(id)?.has(path) || (id === this.catalog().ownerId && isImageFiledFor(basename(path), [WEB_IMAGE_KEY]));
    if (!this.catalog().keys.has(id) || !named || !this.options.workspaceDir) throw refuse();
    const type = MEDIA_TYPES[extname(path).toLowerCase()];
    if (!type) throw refuse();
    let file: FileHandle | undefined;
    try {
      const root = await realpath(join(this.options.workspaceDir, "memory", "incoming-images"));
      const privateRoot = join(await realpath(join(this.options.workspaceDir, "memory")), "private");
      const real = await realpath(path);
      if (!real.startsWith(root + sep) || real.startsWith(privateRoot + sep)) throw refuse();
      file = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      // The store never hard-links; a second link could alias a file elsewhere.
      if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_MEDIA_BYTES) throw refuse();
      const bytes = await file.readFile();
      if (sniffImageType(bytes.subarray(0, 16)) !== type) throw refuse();
      return { type, bytes };
    } catch (error) { throw error instanceof WebError ? error : refuse(); }
    finally { await file?.close(); }
  }

  /**
   * A picture of Tomo's home, by name: only `home/assets/<name>` with a name
   * ASSET_NAME accepts, the real directory exactly there (no symlinked
   * `home` or `assets`), an ordinary single-link file of at most 512 KiB
   * whose bytes are the type its extension says (src/home/files.ts). Every
   * refusal is the same 404, so nothing about other files leaks.
   */
  homeAsset(name: string): { type: string; bytes: Buffer } {
    let decoded: string;
    try { decoded = decodeURIComponent(name); } catch { throw new WebError(404, "asset_not_found"); }
    const file = this.options.workspaceDir ? readHomeAsset(this.options.workspaceDir, decoded) : undefined;
    if (!file) throw new WebError(404, "asset_not_found");
    return file;
  }

  /** A picture or file the agent sent in a session the catalog shows, by its store id. */
  outgoingFile(id: string, mediaId: string): { type: string; bytes: Buffer; name?: string } {
    const key = this.catalog().keys.get(id);
    const file = key && this.outgoing.read(key, mediaId);
    if (!file) throw new WebError(404, "media_not_found");
    return file;
  }

  /**
   * Tool calls of a session the catalog shows (the same gate as its history),
   * read from that session's current SDK transcript.
   */
  async tools(id: string, query: { from?: number; after?: number; transcript?: string }): Promise<SessionTools> {
    const catalog = this.catalog();
    const key = catalog.keys.get(id);
    if (!key) throw new WebError(404, "session_not_found");
    const entry = SessionStore.readSnapshot(this.options.sessionsDir, this.options.sdkSessionsDir).find((e) => e.channelKey === key);
    // The owner's DM shows its calls whole; a group's keep #464's withholding.
    const owner = id === catalog.ownerId && !isGroupSessionKey(key);
    try { return await readSessionTools(this.options.sdkSessionsDir, entry?.sdkSessionId, query, { workspaceDir: this.options.workspaceDir, owner }); }
    catch (error) {
      if (error instanceof SessionToolsError) throw new WebError(error.code === "invalid_cursor" ? 400 : 409, error.code);
      throw error;
    }
  }

  /** The brief of a shown subagent (sessionKey from the daemon's task gate). */
  async subagentBrief(sessionKey: string, taskId: string): Promise<SubagentBrief> {
    const entry = SessionStore.readSnapshot(this.options.sessionsDir, this.options.sdkSessionsDir)
      .find((e) => e.channelKey === sessionKey && e.sdkSessionId);
    const brief = entry ? await readSubagentBrief(this.options.sdkSessionsDir, entry.sdkSessionId, taskId) : undefined;
    if (!brief) throw new WebError(404, "brief_not_found");
    return brief;
  }

  async history(id: string, cursor?: string) {
    const key = this.catalog().keys.get(id);
    if (!key) throw new WebError(404, "session_not_found");
    try {
      const page = await readHistoryPage(this.options, key, cursor);
      // Transcripts keep no structured attachment record, only the channel
      // layer's text marker; a message the owner typed could contain a
      // look-alike. So only images named at the start of an INBOUND user
      // message from a messaging channel count, and only files filed under
      // this session's own channel chats (the image store's own naming).
      const allowed = this.media.get(id) ?? new Set<string>();
      const filedAs = imageSessionKeys(key, this.options.owner, id === this.catalog().ownerId);
      // A picture the agent sent: its MEDIA:/STICKER: tag becomes the id it
      // was filed under at delivery, or "gone" — the path never goes out.
      page.messages = page.messages.map((message) => message.role !== "assistant" ? message
        : (({ mediaRef, ...shown }) => ({ ...shown, content: this.outgoing.rewrite(key, [shown.requestId, shown.turnId, mediaRef], shown.content).content }))(message));
      for (const message of page.messages) {
        if (message.role !== "user" || !INBOUND_CHANNELS.has(message.channel)) continue;
        // A browser upload is filed as web_owner (channels/web.ts), and only a
        // web message may name one; a web message names nothing else.
        const filed = message.channel === "web" ? (id === this.catalog().ownerId ? [WEB_IMAGE_KEY] : []) : filedAs;
        for (const path of imagePaths(message.content)) if (isImageFiledFor(basename(path), filed)) allowed.add(path);
      }
      if (allowed.size > 4096) allowed.clear();
      this.media.set(id, allowed);
      return page;
    }
    catch (error) {
      if (error instanceof HistoryReadError) throw new WebError(
        error.code === "invalid_cursor" ? 400 : error.code === "history_changed" ? 409 : 413, error.code);
      throw error;
    }
  }
}
