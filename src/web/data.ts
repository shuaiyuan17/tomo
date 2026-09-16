import { MemoryReader } from "../workspace/memory-reader.js";
import { WebCron, readSessionContext } from "./inspection.js";
import { WebManagement, type RunningConfig } from "./management.js";
import type { IdentityConfig } from "../config.js";
import { SessionStore } from "../sessions/store.js";
import { readHistoryPage, HistoryReadError } from "../sessions/history-reader.js";
import { isGroupSessionKey, legacySessionKeysForBinding } from "../sessions/keys.js";
import { selectWebOwner, webSessionId } from "./owner.js";
import { WebError, type WebCatalog } from "./protocol.js";

export interface WebDataOptions {
  workspaceDir?: string;
  tomoHome?: string;
  runningConfig?: RunningConfig;
  sessionsDir: string;
  sdkSessionsDir: string;
  identities: IdentityConfig[];
  ownerIdentity?: string;
}

/** Runs in the web process. Never imports the live Agent or starts services. */
export class WebData {
  readonly memory?: MemoryReader;
  readonly cron?: WebCron;
  readonly management?: WebManagement;
  constructor(private readonly options: WebDataOptions) {
    if (options.workspaceDir) this.memory = new MemoryReader(options.workspaceDir);
    if (options.tomoHome) {
      this.cron = new WebCron(options.tomoHome);
      this.management = new WebManagement(options.tomoHome, options.runningConfig);
    }
  }
  async context(id: string) {
    const key = this.catalog().keys.get(id);
    if (!key) throw new WebError(404, "session_not_found");
    const entry = SessionStore.readSnapshot(this.options.sessionsDir, this.options.sdkSessionsDir).find((item) => item.channelKey === key);
    return readSessionContext(entry, this.options.sdkSessionsDir);
  }


  catalog(): WebCatalog & { keys: Map<string, string> } {
    const entries = SessionStore.readSnapshot(this.options.sessionsDir, this.options.sdkSessionsDir);
    const owner = selectWebOwner(this.options.identities, this.options.ownerIdentity);
    const stableOwnerId = owner ? webSessionId(`dm:${owner.name.toLowerCase()}`) : null;
    let ownerKey = owner ? `dm:${owner.name.toLowerCase()}` : undefined;
    if (owner && !entries.some((e) => e.channelKey === ownerKey)) {
      const legacy = Object.entries(owner.channels).flatMap(([channel, chatId]) =>
        legacySessionKeysForBinding(entries.map((e) => e.channelKey), channel, chatId));
      if (legacy.length === 1) ownerKey = legacy[0];
      if (legacy.length > 1) ownerKey = undefined;
    }
    const keys = new Map<string, string>();
    const sessions: WebCatalog["sessions"] = [];
    for (const entry of entries) {
      const group = isGroupSessionKey(entry.channelKey);
      if (!group && entry.channelKey !== ownerKey) continue;
      const id = group ? webSessionId(entry.channelKey) : stableOwnerId!;
      keys.set(id, entry.channelKey);
      sessions.push({ id, title: group ? entry.chatTitle || "Group conversation" : "Owner conversation",
        kind: group ? "group" : "dm", writable: !group,
        lastActiveAt: entry.lastActiveAt,
        stats: { contextUsed: entry.stats?.contextUsed ?? 0, contextMax: entry.stats?.contextMax ?? 0,
          contextEstimated: entry.stats?.contextEstimated } });
    }
    if (ownerKey && !keys.has(stableOwnerId!)) {
      const id = stableOwnerId!;
      keys.set(id, ownerKey);
      sessions.unshift({ id, title: "Owner conversation", kind: "dm", writable: true,
        lastActiveAt: null, stats: { contextUsed: 0, contextMax: 0 } });
    }
    return { sessions, keys, ownerId: ownerKey ? stableOwnerId : null, setupRequired: !ownerKey };
  }

  async history(id: string, cursor?: string) {
    const key = this.catalog().keys.get(id);
    if (!key) throw new WebError(404, "session_not_found");
    try { return await readHistoryPage(this.options, key, cursor); }
    catch (error) {
      if (error instanceof HistoryReadError) throw new WebError(
        error.code === "invalid_cursor" ? 400 : error.code === "history_changed" ? 409 : 413, error.code);
      throw error;
    }
  }
}
