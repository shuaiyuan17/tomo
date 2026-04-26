import { query, type Query, type SDKUserMessage, type SDKMessage, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Channel, IncomingMessage } from "./channels/types.js";
import { config, CONFIG_PATH, RESTART_REASON_FILE } from "./config.js";
import { buildSystemPrompt } from "./workspace/index.js";
import { SessionStore } from "./sessions/index.js";
import type { ReplyTarget } from "./sessions/types.js";
import { checkAndClearCompactTrigger } from "./lcm/index.js";
import { isGroupSessionKey } from "./lcm/blocks.js";
import { IdentityRouter } from "./router.js";
import { createTomoInternalMcpServer, TOMO_INTERNAL_MCP_NAME } from "./mcp/internal-server.js";
import { log } from "./logger.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";

export type SendResult = { ok: true } | { ok: false; error: string };

export interface SessionCatalog {
  identities: Array<{ name: string }>;
  groups: Array<{ key: string; title?: string; participants?: string[] }>;
}

// DM sessions run our custom hierarchical LCM (daily/weekly/monthly/yearly
// rollups via skill), so SDK auto-compact is disabled for them via the
// DISABLE_AUTO_COMPACT env var — we don't want the SDK to collapse our
// rollup structure behind our back. Group sessions skip the custom LCM
// entirely and rely on SDK auto-compact, so we leave it enabled there.

function isSilentReply(text: string): boolean {
  return /^\s*NO_REPLY\s*$/i.test(text);
}

const MEDIA_RE = /\bMEDIA:\s*"?([^\n"]+)"?/gi;

function extractMedia(text: string): { cleanText: string; mediaPaths: string[] } {
  const mediaPaths: string[] = [];
  const cleanText = text.replace(MEDIA_RE, (_match, path) => {
    mediaPaths.push(path.trim());
    return "";
  }).trim();
  return { cleanText, mediaPaths };
}

const SKILLS_DIR = `${config.workspaceDir}/.claude/skills/`;

async function skillsCanUseTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> {
  const filePath = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
  if (filePath && filePath.startsWith(SKILLS_DIR)) {
    return { behavior: "allow", updatedInput: input };
  }
  // Bash mkdir / touch / etc. — allow if command targets the skills dir.
  if (toolName === "Bash" && typeof input.command === "string" && input.command.includes(SKILLS_DIR)) {
    return { behavior: "allow", updatedInput: input };
  }
  return {
    behavior: "deny",
    message: `Permission required for ${toolName}${filePath ? ` on ${filePath}` : ""} — only ${SKILLS_DIR}** is auto-approved at this step.`,
  };
}

function sdkOptions(
  internalMcpServer: McpSdkServerConfigWithInstance,
  resumeSessionId?: string,
  model?: string,
  sessionContext?: { sessionKey: string; sdkSessionId?: string },
) {
  let systemPrompt = buildSystemPrompt();

  // Inject session context so the agent can use LCM tools
  if (sessionContext) {
    const lines = [
      "\n\n# SESSION — Current Session Info",
      `- Session key: ${sessionContext.sessionKey}`,
    ];
    if (sessionContext.sdkSessionId) {
      lines.push(`- SDK session ID: ${sessionContext.sdkSessionId}`);
    }
    systemPrompt += lines.join("\n");
  }

  return {
    model: model ?? config.model,
    cwd: config.workspaceDir,
    systemPrompt,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    allowedTools: [
      "Read", "Write", "Edit", "Bash", "Glob", "Grep",
      "WebSearch", "WebFetch", "Agent", "NotebookEdit", "TodoWrite", "Skill",
      `mcp__${TOMO_INTERNAL_MCP_NAME}__send_message`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__list_sessions`,
    ],
    mcpServers: { [TOMO_INTERNAL_MCP_NAME]: internalMcpServer },
    settingSources: ["project"] as ("project")[],
    settings: {
      attribution: {
        commit: "Made by [Tomo](https://github.com/shuaiyuan17/tomo)",
        pr: "Made by [Tomo](https://github.com/shuaiyuan17/tomo)",
      },
    },
    // bypassPermissions auto-approves most tools at step 3 of the permission
    // flow, but writes to `.claude/`, `.git/`, etc. are protected and fall
    // through to step 5 (canUseTool). We narrowly re-allow `.claude/skills/`
    // here so tomo can manage its own skill library, while leaving every
    // other protected path on its default (deny). See:
    // https://code.claude.com/docs/en/agent-sdk/permissions#permission-modes
    canUseTool: skillsCanUseTool,
    includePartialMessages: true,
    maxTurns: config.maxTurns,
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    // Note: SDK `env` fully replaces the child's env (not merged despite the
    // d.ts claim), so we must spread process.env ourselves — otherwise the
    // child CLI spawns with an empty env and fails to locate its runtime.
    ...(sessionContext && !isGroupSessionKey(sessionContext.sessionKey)
      ? { env: { ...process.env, DISABLE_AUTO_COMPACT: "1" } }
      : {}),
  };
}

// --- Live Session (streaming input mode) ---

interface MessageRequest {
  message: SDKUserMessage;
  onText?: (text: string) => void;
  resolve: (response: string) => void;
  reject: (err: Error) => void;
}

interface QueryResult {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextUsed: number;
  contextMax: number;
  contextBreakdown?: { name: string; tokens: number }[];
}

class LiveSession {
  private q: Query;
  private pendingMessage: ((msg: SDKUserMessage) => void) | null = null;
  private currentRequest: MessageRequest | null = null;
  private parts: string[] = [];
  private streamingText = "";
  private sessionId: string | null = null;
  private alive = true;
  lastResult: QueryResult | null = null;
  private prevTotalCost = 0;
  private eventLoopDone: Promise<void>;
  private sessionKey: string | undefined;
  // Maps tool_use_id → tool name so we can label tool_result log lines
  // (the result event only carries the use id, not the original name).
  private pendingToolNames = new Map<string, string>();

  constructor(options: ReturnType<typeof sdkOptions>, sessionKey?: string) {
    this.sessionKey = sessionKey;
    this.q = query({ prompt: this.messageGenerator(), options });
    this.eventLoopDone = this.consumeEvents();
  }

  private async *messageGenerator(): AsyncGenerator<SDKUserMessage> {
    while (this.alive) {
      const msg = await new Promise<SDKUserMessage>((resolve) => {
        this.pendingMessage = resolve;
      });
      this.pendingMessage = null;
      yield msg;
    }
  }

  private async consumeEvents(): Promise<void> {
    try {
      for await (const event of this.q) {
        await this.handleEvent(event);
      }
    } catch (err) {
      // If there's a pending request, reject it
      if (this.currentRequest) {
        this.currentRequest.reject(err instanceof Error ? err : new Error(String(err)));
        this.currentRequest = null;
      }
    }
    this.alive = false;
  }

  private async handleEvent(event: SDKMessage): Promise<void> {
    const req = this.currentRequest;

    if (event.type === "stream_event") {
      const se = event as unknown as { event: { type: string; delta?: { type: string; text?: string } } };
      if (se.event?.type === "content_block_delta" && se.event.delta?.type === "text_delta" && se.event.delta.text) {
        this.streamingText += se.event.delta.text;
        req?.onText?.(this.streamingText);
      }
    }

    if (event.type === "assistant" && event.message?.content) {
      this.streamingText = "";
      for (const block of event.message.content) {
        if ("text" in block) {
          this.parts.push(block.text);
        } else if ("type" in block && block.type === "tool_use") {
          const tool = block as { id?: string; name: string; input?: Record<string, unknown> };
          if (tool.id && tool.name) this.pendingToolNames.set(tool.id, tool.name);
          log.info({ tool: tool.name }, summarizeToolInput(tool.name, tool.input));
        }
      }
    }

    if (event.type === "user" && event.message?.content && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (block && typeof block === "object" && "type" in block && block.type === "tool_result") {
          const tr = block as { tool_use_id?: string; content?: unknown; is_error?: boolean };
          const name = tr.tool_use_id ? this.pendingToolNames.get(tr.tool_use_id) : undefined;
          if (tr.tool_use_id) this.pendingToolNames.delete(tr.tool_use_id);
          log.info(
            { tool: name ?? "?", is_error: tr.is_error ?? false },
            `result: ${summarizeToolResult(tr.content)}`,
          );
        }
      }
    }

    if (event.type === "system" && (event as { subtype?: string }).subtype === "compact_boundary") {
      const compact = event as { compact_metadata?: { pre_tokens?: number; post_tokens?: number } };
      log.info(
        { pre: compact.compact_metadata?.pre_tokens, post: compact.compact_metadata?.post_tokens },
        "Context compacted",
      );
    }

    if (event.type === "tool_use_summary") {
      log.debug((event as { summary: string }).summary);
    }

    if (event.type === "result") {
      const result = event as unknown as {
        subtype: string;
        num_turns?: number;
        duration_ms?: number;
        total_cost_usd?: number;
        usage?: Record<string, unknown>;
        session_id?: string;
      };

      if (result.session_id) {
        this.sessionId = result.session_id;
      }

      const u = result.usage as Record<string, number> | undefined;
      const input = u?.input_tokens ?? 0;
      const output = u?.output_tokens ?? 0;
      const cacheRead = u?.cache_read_input_tokens ?? 0;
      const cacheCreated = u?.cache_creation_input_tokens ?? 0;

      // Compute per-turn cost as delta from cumulative total
      const totalCost = result.total_cost_usd ?? 0;
      const turnCost = totalCost - this.prevTotalCost;
      this.prevTotalCost = totalCost;

      // Store result stats, get context usage, then resolve
      this.lastResult = {
        costUsd: totalCost,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreated,
        contextUsed: 0,
        contextMax: 0,
      };

      // Await context usage before resolving so stats are complete
      await this.logContextUsage(result, turnCost, totalCost, input, output, cacheRead, cacheCreated);

      const response = this.parts.join("\n").trim() || "I'm not sure how to respond to that.";
      this.parts = [];
      this.streamingText = "";
      req?.resolve(response);
      this.currentRequest = null;
    }
  }

  private async logContextUsage(
    result: { subtype: string; num_turns?: number; duration_ms?: number },
    turnCost: number, totalCost: number,
    input: number, output: number, cacheRead: number, cacheCreated: number,
  ): Promise<void> {
    const contextInfo = await (async () => {
      try {
        const ctx = await this.q.getContextUsage();
        const pct = Math.round(ctx.percentage);
        if (this.lastResult) {
          this.lastResult.contextUsed = ctx.totalTokens;
          this.lastResult.contextMax = ctx.maxTokens;
          this.lastResult.contextBreakdown = ctx.categories
            .filter((c) => c.tokens > 0)
            .map((c) => ({ name: c.name, tokens: c.tokens }));
        }
        if (pct >= 80) {
          log.warn({ used: ctx.totalTokens, max: ctx.maxTokens, pct: `${pct}%` }, "Context nearing compaction");
        }
        return `${ctx.totalTokens}/${ctx.maxTokens} (${pct}%)`;
      } catch {
        const approx = input + cacheRead + cacheCreated;
        if (this.lastResult) {
          this.lastResult.contextUsed = approx;
          this.lastResult.contextMax = 1_000_000;
        }
        return `~${approx}/1000000`;
      }
    })();

    log.info(
      {
        session: this.sessionKey,
        turns: result.num_turns,
        duration: `${result.duration_ms}ms`,
        cost: `$${turnCost.toFixed(4)}`,
        totalCost: `$${totalCost.toFixed(4)}`,
        tokens: `in:${input} out:${output}`,
        cache: `read:${cacheRead} created:${cacheCreated}`,
        context: contextInfo,
      },
      "Run completed (%s)", result.subtype,
    );
  }

  async send(text: string, onText?: (text: string) => void, images?: Array<{ data: string; mediaType: string }>): Promise<string> {
    if (!this.alive) throw new Error("Session is closed");

    const TIMEOUT_MS = 10 * 60 * 1000; // 10 minute timeout per send()

    // Build content blocks
    type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    const content: Array<Record<string, unknown>> = [];
    if (images && images.length > 0) {
      for (const img of images) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType as ImageMediaType, data: img.data },
        });
      }
    }
    content.push({ type: "text", text });

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.currentRequest = null;
        reject(new Error("Query timed out after 10 minutes"));
      }, TIMEOUT_MS);

      const wrappedResolve = (val: string) => { clearTimeout(timer); resolve(val); };
      const wrappedReject = (err: Error) => { clearTimeout(timer); reject(err); };

      this.currentRequest = {
        message: { type: "user", message: { role: "user", content: content as never }, parent_tool_use_id: null },
        onText,
        resolve: wrappedResolve,
        reject: wrappedReject,
      };
      this.parts = [];
      this.streamingText = "";

      if (this.pendingMessage && this.currentRequest) {
        this.pendingMessage(this.currentRequest.message);
      } else {
        wrappedReject(new Error("Session not ready to receive messages"));
      }
    });
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  isAlive(): boolean {
    return this.alive;
  }

  close(): void {
    this.alive = false;
    this.q.close();
  }
}

// --- Agent ---

function summarizeToolResult(content: unknown): string {
  // Tool results arrive as either a string or an array of content blocks
  // ({type:"text",text:"..."} | {type:"image",...} | etc.). We flatten to a
  // short readable string for log lines — no need to be exhaustive.
  if (content == null) return "(empty)";
  if (typeof content === "string") return content.slice(0, 500);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object") {
        if ("text" in b && typeof (b as { text: unknown }).text === "string") {
          parts.push((b as { text: string }).text);
        } else if ("type" in b) {
          parts.push(`<${(b as { type: string }).type}>`);
        }
      }
    }
    return parts.join(" ").slice(0, 500);
  }
  return JSON.stringify(content).slice(0, 500);
}

function summarizeToolInput(name: string, input?: Record<string, unknown>): string {
  if (!input) return name;
  switch (name) {
    case "Read": return `Read ${input.file_path}`;
    case "Write": return `Write ${input.file_path}`;
    case "Edit": return `Edit ${input.file_path}`;
    case "Bash": return `Bash: ${String(input.command).slice(0, 500)}`;
    case "Glob": return `Glob ${input.pattern}`;
    case "Grep": return `Grep "${input.pattern}"`;
    case "WebSearch": return `WebSearch: ${input.query}`;
    case "WebFetch": return `WebFetch: ${input.url}`;
    default: return `${name}: ${JSON.stringify(input).slice(0, 500)}`;
  }
}

export class Agent {
  private channels: Channel[] = [];
  private sessions: SessionStore;
  private router: IdentityRouter;
  private liveSessions = new Map<string, LiveSession>();
  private messageQueues = new Map<string, Promise<void>>();
  private groupParticipants = new Map<string, Set<string>>();
  private modelOverrides = new Map<string, string>();
  private lastPromptHash: string = "";
  // Context-usage hysteresis: track whether we've nudged the agent to compact
  // for the current over-threshold episode. Reset when usage drops below LOW.
  private contextNudged = new Map<string, boolean>();
  // Notes queued by sendToSession() — drained and prepended to the recipient's
  // next user/cron/continuity turn so their Claude has context that a
  // proactive message went out.
  private pendingNotes = new Map<string, string[]>();
  private readonly internalMcpServer: McpSdkServerConfigWithInstance;

  constructor() {
    this.sessions = new SessionStore(config.sessionsDir, config.historyLimit);
    this.router = new IdentityRouter(config.identities, this.sessions, config.channelAllowlists);
    this.internalMcpServer = createTomoInternalMcpServer(this);

    // Load persistent per-session model overrides
    for (const [key, model] of Object.entries(config.sessionModelOverrides)) {
      this.modelOverrides.set(key, model);
    }
  }

  /** Look up a channel by name */
  private getChannel(name: string): Channel | undefined {
    return this.channels.find((ch) => ch.name === name);
  }

  /**
   * Is this group a "passive listen" group? Tomo sees every message (no
   * @mention required) and decides via NO_REPLY whether to respond.
   * iMessage groups are always passive (the channel can't reliably detect
   * mentions). Telegram (and others) opt in via config.passiveGroups.
   */
  private isPassiveListenGroup(channelName: string, chatId: string): boolean {
    if (channelName === "imessage") return true;
    return (config.passiveGroups[channelName] ?? []).includes(chatId);
  }

  /** Activate a group chat by adding it to the channel's allowlist */
  private async activateGroup(channel: Channel, chatId: string): Promise<void> {
    try {
      const { readFileSync, writeFileSync } = await import("node:fs");
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      const channels = (cfg.channels ?? {}) as Record<string, Record<string, unknown>>;
      if (!channels[channel.name]) channels[channel.name] = {};
      const allowlist = ((channels[channel.name].allowlist ?? []) as string[]);
      if (!allowlist.includes(chatId)) {
        allowlist.push(chatId);
        channels[channel.name].allowlist = allowlist;
        cfg.channels = channels;
        writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
        // Update the router's in-memory allowlist
        this.router.addToAllowlist(channel.name, chatId);
      }
      log.info({ channel: channel.name, chatId }, "Group chat activated via secret");
      await channel.send({ chatId, text: "Tomo activated in this group." });
    } catch (err) {
      log.error({ err }, "Failed to activate group");
    }
  }

  addChannel(channel: Channel): void {
    channel.onMessage((msg) => this.enqueueMessage(channel, msg));
    channel.onCommand((cmd, chatId, senderName, args) => this.handleCommand(channel, cmd, chatId, senderName, args));
    this.channels.push(channel);
  }

  /** Active sessions as [sessionKey, sdkSessionId] pairs (RollupRunner etc). */
  listActiveSessions(): [string, string][] {
    return this.sessions.listSdkSessionIds();
  }

  /**
   * Serialize work on a session key across ALL ingress paths (user, cron,
   * continuity). Each task runs FIFO so only one send() is in flight per
   * key at any time — prevents LiveSession's shared currentRequest slot
   * from being stomped by overlapping callers.
   */
  private enqueueForSession<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
    const prev = this.messageQueues.get(sessionKey) ?? Promise.resolve();
    const result = prev.then(() => task());
    // Keep the queue alive even if this task throws
    const next = result.then(() => {}, (err) => {
      log.error({ err, sessionKey }, "Unhandled error in session queue");
    });
    this.messageQueues.set(sessionKey, next);
    return result;
  }

  /** Queue messages per session key so they process sequentially */
  private enqueueMessage(channel: Channel, message: IncomingMessage): Promise<void> {
    const isGroup = message.isGroup ?? false;
    const { sessionKey } = this.router.resolve(channel.name, message.chatId, isGroup);
    return this.enqueueForSession(sessionKey, () => this.handleMessage(channel, message))
      .catch((err) => {
        log.error({ err, sessionKey }, "Unhandled error in message queue");
      });
  }

  private static readonly AVAILABLE_MODELS: Record<string, string> = {
    "sonnet": "claude-sonnet-4-6",
    "sonnet-1m": "claude-sonnet-4-6[1m]",
    "opus": "claude-opus-4-7",
    "opus-1m": "claude-opus-4-7[1m]",
    "haiku": "claude-haiku-4-5",
  };

  private async handleCommand(channel: Channel, command: string, chatId: string, senderName: string, args?: string): Promise<void> {
    const { sessionKey: key } = this.router.resolve(channel.name, chatId, false);

    if (command === "new") {
      this.closeLiveSession(key);
      this.sessions.clearSdkSessionId(key);
      log.info({ channel: channel.name, chatId, sender: senderName }, "New session started via /new");
      await channel.send({ chatId, text: "New session started." });
      return;
    }

    if (command === "model") {
      const arg = args?.trim().toLowerCase();
      if (!arg) {
        const current = this.modelOverrides.get(key) ?? config.model;
        const lines = [`Current: ${current}`, "", "Switch with: /model <name>", ""];
        for (const [shortName, fullName] of Object.entries(Agent.AVAILABLE_MODELS)) {
          const marker = fullName === current ? " (active)" : "";
          lines.push(`  ${shortName} — ${fullName}${marker}`);
        }
        await channel.send({ chatId, text: lines.join("\n") });
        return;
      }

      const resolved = Agent.AVAILABLE_MODELS[arg] ?? arg;
      this.modelOverrides.set(key, resolved);
      // Model change requires new session (process uses one model)
      this.closeLiveSession(key);
      log.info({ channel: channel.name, chatId, model: resolved }, "Model switched via /model");
      await channel.send({ chatId, text: `Switched to ${resolved}` });
      return;
    }

    if (command === "status") {
      const model = this.modelOverrides.get(key) ?? config.model;
      const session = this.sessions.get(key);
      const entry = this.sessions.getEntry(key);
      const live = this.liveSessions.get(key);

      const lines: string[] = [];
      lines.push(`Session: ${key}`);
      lines.push(`Channel: ${channel.name}`);
      lines.push(`Model: ${model}`);
      lines.push(`Live: ${live?.isAlive() ? "yes" : "no"}`);

      const msgCount = session.messages.filter((m) => m.role === "user").length;
      lines.push(`Messages: ${msgCount} user turns`);

      if (session.createdAt) {
        lines.push(`Created: ${new Date(session.createdAt).toLocaleString()}`);
      }
      if (session.updatedAt) {
        lines.push(`Last active: ${new Date(session.updatedAt).toLocaleString()}`);
      }

      if (entry?.stats) {
        const s = entry.stats;
        lines.push("");
        lines.push(`Queries: ${s.totalQueries}`);
        lines.push(`Cost: $${s.totalCostUsd.toFixed(4)}`);
        lines.push(`Tokens: ${s.totalInputTokens.toLocaleString()} in / ${s.totalOutputTokens.toLocaleString()} out`);
        if (s.contextMax > 0) {
          const pct = ((s.contextUsed / s.contextMax) * 100).toFixed(0);
          lines.push(`Context: ${pct}% (${s.contextUsed.toLocaleString()} / ${s.contextMax.toLocaleString()})`);
        }
      }

      await channel.send({ chatId, text: lines.join("\n") });
      return;
    }
  }

  private getOrCreateLiveSession(key: string): LiveSession {
    let session = this.liveSessions.get(key);
    if (session?.isAlive()) return session;

    // Check prompt changes
    const currentHash = this.hashString(buildSystemPrompt());
    if (this.lastPromptHash && currentHash !== this.lastPromptHash) {
      log.info("System prompt changed, creating new sessions");
      for (const [k, s] of this.liveSessions) {
        s.close();
        this.liveSessions.delete(k);
      }
    }
    this.lastPromptHash = currentHash;

    const resumeId = this.sessions.getSdkSessionId(key);
    const model = this.modelOverrides.get(key);
    const opts = sdkOptions(this.internalMcpServer, resumeId ?? undefined, model, {
      sessionKey: key,
      sdkSessionId: resumeId ?? undefined,
    });

    session = new LiveSession(opts, key);
    this.liveSessions.set(key, session);
    log.info({ key, resume: !!resumeId, model: opts.model }, "Live session created");
    return session;
  }

  private closeLiveSession(key: string): void {
    const session = this.liveSessions.get(key);
    if (session) {
      session.close();
      this.liveSessions.delete(key);
    }
  }

  private hashString(s: string): string {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    }
    return String(hash);
  }

  private async handleMessage(channel: Channel, message: IncomingMessage): Promise<void> {
    const hasImages = message.images && message.images.length > 0;
    const isGroup = message.isGroup ?? false;
    const isMentioned = message.isMentioned ?? false;

    log.info(
      { channel: channel.name, sender: message.senderName, group: isGroup || undefined, mentioned: isMentioned || undefined, images: hasImages ? message.images!.length : undefined },
      message.text,
    );

    // Group secret activation: if message matches the secret, add group to allowlist
    if (isGroup && config.groupSecret && message.text.trim() === config.groupSecret) {
      await this.activateGroup(channel, message.chatId);
      return;
    }

    // Allowlist check: reject messages from unknown senders
    if (!this.router.isAllowed(channel.name, message.chatId)) {
      log.debug({ channel: channel.name, chatId: message.chatId }, "Message blocked (not in allowlist)");
      return;
    }

    const resolution = this.router.resolve(channel.name, message.chatId, isGroup);
    const key = resolution.sessionKey;
    const replyChannel = this.getChannel(resolution.replyTarget.channelName) ?? channel;
    const replyChatId = resolution.replyTarget.chatId;

    const textForAgent = isGroup ? `${message.senderName}: ${message.text}` : message.text;

    if (isGroup) {
      await this.updateGroupContext(key, message.senderName, channel.name, message.chatTitle);
    }

    this.sessions.append(key, {
      role: "user",
      content: textForAgent,
      channel: channel.name,
      senderName: message.senderName,
      timestamp: message.timestamp,
    });

    const isPassiveGroup = isGroup && this.isPassiveListenGroup(channel.name, message.chatId);

    if (isGroup && !isMentioned && !isPassiveGroup) {
      log.debug("Group message ignored (not mentioned)");
      return;
    }

    // Passive groups: skip typing indicator (most messages will be NO_REPLY)
    const stopTyping = isPassiveGroup ? () => {} : replyChannel.startTyping(replyChatId);

    try {
      const stampedText = this.drainPendingNotes(key) + this.injectTimestamp(textForAgent, channel.name);

      const stream = replyChannel.createStreamingMessage(replyChatId, isGroup ? message.id : undefined);
      const response = await this.runWithRetry(key, stampedText, (text) => {
        stream.update(text.replace(MEDIA_RE, "").trim());
      }, message.images);
      stopTyping();

      // If context is high, send a system nudge so the agent can compact.
      // Skip for group sessions — they use SDK auto-compact, not the lcm skill.
      const liveSession = this.liveSessions.get(key);
      const ctx = liveSession?.lastResult;
      if (ctx && ctx.contextMax > 0 && !isGroupSessionKey(key)) {
        const pct = Math.round((ctx.contextUsed / ctx.contextMax) * 100);
        if (pct >= 80) {
          this.runWithRetry(key, `System: Context usage is at ${pct}% (${ctx.contextUsed}/${ctx.contextMax} tokens). Use the lcm compact skill to free up space before the next user message.`).catch(() => {});
        }
      }

      this.sessions.append(key, {
        role: "assistant",
        content: response,
        channel: replyChannel.name,
        timestamp: Date.now(),
      });

      log.info({ channel: replyChannel.name }, "Tomo: %s", response);

      if (isSilentReply(response)) {
        log.info("Silent reply (no message sent)");
        return;
      }

      // Surface API errors that the SDK returns as response text
      if (/^API Error: \d+/i.test(response) || /^\{"type":"error"/.test(response)) {
        await stream.finish();
        await replyChannel.send({ chatId: replyChatId, text: `[error] ${response}` });
        return;
      }

      const { cleanText, mediaPaths } = extractMedia(response);

      if (mediaPaths.length > 0) {
        const { existsSync: fileExists } = await import("node:fs");
        const validPaths = mediaPaths.filter((p) => fileExists(p));
        if (validPaths.length > 0) {
          for (let i = 0; i < validPaths.length; i++) {
            await replyChannel.send({
              chatId: replyChatId,
              photo: validPaths[i],
              text: i === 0 ? cleanText : "",
            });
          }
        } else {
          stream.update(cleanText);
          await stream.finish();
        }
      } else {
        await stream.finish();
      }
    } catch (err) {
      stopTyping();
      log.error({ err }, "Error handling message");

      // Passive groups: suppress error messages to avoid polluting the chat
      if (isPassiveGroup) return;

      const detail = err instanceof Error ? err.message : String(err);
      await replyChannel.send({
        chatId: replyChatId,
        text: `[error] ${detail}`,
      });
    }
  }

  private async runWithRetry(key: string, prompt: string, onText?: (text: string) => void, images?: Array<{ data: string; mediaType: string }>): Promise<string> {
    try {
      const session = this.getOrCreateLiveSession(key);
      const response = await session.send(prompt, onText, images);

      // Capture session ID if new
      const sid = session.getSessionId();
      if (sid && !this.sessions.getSdkSessionId(key)) {
        this.sessions.setSdkSessionId(key, sid);
        log.info({ sessionId: sid, key }, "Session ID captured");
      }

      // Save stats
      if (session.lastResult) {
        this.sessions.updateStats(key, session.lastResult);
      }

      // If compact happened during this turn, reload the session on next turn
      if (sid && checkAndClearCompactTrigger(sid)) {
        this.closeLiveSession(key);
        log.info({ key }, "Session reloaded after compact");
      }

      // Context-usage hysteresis: nudge agent to run `tomo lcm daily` when
      // context usage crosses the high-water mark; reset when it drops back
      // below the low-water mark (a successful compact knocks it well under).
      // Skip for group sessions — they use SDK default compact.
      if (sid && !isGroupSessionKey(key)) {
        const HIGH = 0.70; // nudge at or above 70% of window
        const LOW = 0.60;  // reset nudged flag below 60%
        const ctxUsed = session.lastResult?.contextUsed ?? 0;
        const ctxMax = session.lastResult?.contextMax ?? 0;
        const usedFrac = ctxMax > 0 ? ctxUsed / ctxMax : 0;
        const nudged = this.contextNudged.get(key) === true;

        if (usedFrac < LOW && nudged) {
          this.contextNudged.set(key, false);
        }

        if (usedFrac >= HIGH && !nudged) {
          this.contextNudged.set(key, true);
          const pct = Math.round(usedFrac * 100);
          const nudge = `System: Context usage is at ${pct}% of the window. Please run \`tomo lcm daily --session-id ${sid} --summary "<today-so-far>"\` to roll up today's activity. Two things to know: (1) the daily compact OVERRIDES today's existing daily block — it does not append; write a fresh summary covering the whole day. (2) The command preserves the last 32 raw events as fresh tail. After the compact finishes, reply NO_REPLY so we don't send a user-facing message for this housekeeping turn.`;
          log.info({ key, usedPct: `${pct}%` }, "Context nudge (agent should run lcm daily)");
          // Fire-and-forget — don't block the current reply on the nudge
          this.handleCronMessage(nudge, key).catch((err) => {
            log.warn({ err, key }, "Context nudge failed");
          });
        }
      }

      return response;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "";

      if (errMsg.includes("maximum number of turns")) {
        log.warn("Hit max turns, returning partial response");
        return "I ran out of steps trying to complete that. Can you try a simpler request?";
      }

      // Session error — reset and retry once
      if (errMsg.includes("No conversation found") || errMsg.includes("session") || errMsg.includes("closed")) {
        log.warn({ err }, "Session error, resetting and retrying");
        this.closeLiveSession(key);
        this.sessions.clearSdkSessionId(key);

        const session = this.getOrCreateLiveSession(key);
        return session.send(prompt, onText, images);
      }

      throw err;
    }
  }

  private async updateGroupContext(key: string, senderName: string, channelName: string, chatTitle?: string): Promise<void> {
    let participants = this.groupParticipants.get(key);
    const isNew = !participants;

    if (!participants) {
      participants = new Set();
      this.groupParticipants.set(key, participants);
    }

    const wasKnown = participants.has(senderName);
    participants.add(senderName);
    this.sessions.addParticipant(key, senderName);
    if (chatTitle) this.sessions.setChatTitle(key, chatTitle);

    if (isNew || !wasKnown) {
      const names = [...participants].join(", ");
      const title = chatTitle ? `"${chatTitle}"` : "a group chat";
      let contextMsg = `System: You are in ${title}. Participants so far: ${names}. Messages are prefixed with sender names.`;

      // Passive-listen groups (iMessage always; Telegram via config.passiveGroups):
      // inject guidance to stay silent unless genuinely useful.
      const chatId = key.includes(":") ? key.slice(key.indexOf(":") + 1) : "";
      if (isNew && this.isPassiveListenGroup(channelName, chatId)) {
        contextMsg += ` You see every message in this ${channelName} group but should only reply when you have something genuinely useful to add. Reply NO_REPLY to stay silent. Do not respond to casual chatter, greetings, or messages not directed at you.`;
      }

      try {
        await this.runWithRetry(key, contextMsg);
        log.info({ group: chatTitle, participants: names }, "Group context updated");
      } catch (err) {
        log.warn({ err }, "Failed to inject group context");
      }
    }
  }

  private injectTimestamp(text: string, channelName?: string): string {
    const now = new Date();
    const weekday = now.toLocaleDateString("en-US", { weekday: "short" });
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const date = `${mm}/${dd}`;
    const time = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const tz = now.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
    const prefix = channelName ? `${channelName} · ` : "";
    return `[${prefix}${weekday} ${date} ${time} ${tz}] ${text}`;
  }

  /** Handle a cron-triggered message (queued per session key) */
  async handleCronMessage(message: string, sessionKey: string): Promise<void> {
    return this.enqueueForSession(sessionKey, () => this.processCronMessage(message, sessionKey))
      .catch((err) => {
        log.error({ err, sessionKey }, "Cron message failed in queue");
      });
  }

  private async processCronMessage(message: string, sessionKey: string): Promise<void> {
    const key = sessionKey;
    let deliveryChannel: Channel;
    let deliveryChatId: string;

    if (sessionKey.startsWith("dm:")) {
      // Unified identity session — read persisted replyTarget, fall back to identity config
      const identityName = sessionKey.slice(3);
      const target =
        this.router.getReplyTarget(sessionKey) ??
        this.router.deriveReplyTargetFromConfig(identityName);
      if (!target) {
        log.warn({ sessionKey }, "Cron: no reply target for dm session");
        return;
      }
      const ch = this.getChannel(target.channelName);
      if (!ch) {
        log.warn({ sessionKey, channelName: target.channelName }, "Cron: channel not loaded");
        return;
      }
      deliveryChannel = ch;
      deliveryChatId = target.chatId;
    } else {
      // Raw per-channel key: <channel>:<chatId> (DM without identity, or group chat)
      const colonIdx = sessionKey.indexOf(":");
      if (colonIdx < 0) {
        log.warn({ sessionKey }, "Cron: invalid session key");
        return;
      }
      const channelName = sessionKey.slice(0, colonIdx);
      const chatId = sessionKey.slice(colonIdx + 1);
      const ch = this.getChannel(channelName);
      if (!ch) {
        log.warn({ sessionKey, channelName }, "Cron: channel not loaded");
        return;
      }
      deliveryChannel = ch;
      deliveryChatId = chatId;
    }

    const stampedMessage = this.drainPendingNotes(key) + this.injectTimestamp(message, deliveryChannel.name);
    log.info({ channel: deliveryChannel.name, sender: "cron" }, message);

    const stopTyping = deliveryChannel.startTyping(deliveryChatId);

    try {
      const response = await this.runWithRetry(key, stampedMessage);
      stopTyping();

      log.info({ channel: deliveryChannel.name }, "Tomo: %s", response);

      if (isSilentReply(response) || response.includes("NO_REPLY")) {
        log.info("Cron completed silently (no reply sent)");
        return;
      }

      this.sessions.append(key, {
        role: "assistant",
        content: response,
        channel: deliveryChannel.name,
        timestamp: Date.now(),
      });

      await deliveryChannel.send({ chatId: deliveryChatId, text: response });
    } catch (err) {
      stopTyping();
      log.error({ err }, "Cron message handling failed");
      const detail = err instanceof Error ? err.message : String(err);
      await deliveryChannel.send({ chatId: deliveryChatId, text: `[error] cron failed: ${detail}` });
    }
  }

  /** Handle a continuity heartbeat — runs on the first active DM session (queued) */
  async handleContinuity(prompt: string): Promise<void> {
    // Resolve target session key first so we can enqueue against it
    const dmKey = this.router.findFirstDmSession();
    let key: string;

    if (dmKey) {
      key = dmKey;
    } else {
      const channel = this.channels[0];
      if (!channel) { log.warn("Continuity: no channel available"); return; }
      const chatId = this.findLastChatId(channel.name);
      if (!chatId) { log.debug("Continuity: no active session, skipping"); return; }
      key = `${channel.name}:${chatId}`;
    }

    return this.enqueueForSession(key, () => this.processContinuity(prompt, key))
      .catch((err) => {
        log.error({ err, sessionKey: key }, "Continuity failed in queue");
      });
  }

  private async processContinuity(prompt: string, key: string): Promise<void> {
    try {
      const response = await this.runWithRetry(key, this.drainPendingNotes(key) + prompt);
      log.info("Continuity response: %s", response.slice(0, 100));

      // Send non-silent responses to the user (check includes() for multi-turn responses
      // where NO_REPLY may appear after earlier text output)
      if (!isSilentReply(response) && !response.includes("NO_REPLY")) {
        const replyTarget = this.router.getReplyTarget(key)
          ?? (key.startsWith("dm:") ? this.router.deriveReplyTargetFromConfig(key.slice(3)) : undefined)
          ?? this.parseChannelKey(key);

        if (replyTarget) {
          const channel = this.getChannel(replyTarget.channelName);
          if (channel) {
            const { cleanText, mediaPaths } = extractMedia(response);
            if (mediaPaths.length > 0) {
              const validPaths = mediaPaths.filter((p) => existsSync(p));
              for (let i = 0; i < validPaths.length; i++) {
                await channel.send({
                  chatId: replyTarget.chatId,
                  photo: validPaths[i],
                  text: i === 0 ? cleanText : "",
                });
              }
            } else {
              await channel.send({ chatId: replyTarget.chatId, text: cleanText });
            }
          }
        }
      }
    } catch (err) {
      log.error({ err }, "Continuity heartbeat failed");
    }
  }

  /** Parse a "channel:chatId" key into a reply target (fallback for non-identity users).
   *  Skips group chats (Telegram negative IDs, iMessage group GUIDs). */
  private parseChannelKey(key: string): ReplyTarget | undefined {
    if (key.startsWith("dm:")) return undefined; // dm keys use deriveReplyTargetFromConfig
    const colonIdx = key.indexOf(":");
    if (colonIdx < 0) return undefined;
    const channelName = key.slice(0, colonIdx);
    const chatId = key.slice(colonIdx + 1);
    if (!channelName || !chatId) return undefined;
    // Skip Telegram group chats (negative IDs)
    if (channelName === "telegram" && chatId.startsWith("-")) return undefined;
    // Skip iMessage group chats (GUID contains ";+;")
    if (channelName === "imessage" && chatId.includes(";+;")) return undefined;
    return { channelName, chatId };
  }

  private findLastChatId(channelName: string): string | undefined {
    for (const [key] of this.sessions.listSdkSessionIds()) {
      if (key.startsWith(`${channelName}:`)) {
        return key.slice(channelName.length + 1);
      }
    }
    return undefined;
  }

  /**
   * Direct mode: post a verbatim message to a target session via Channel.send().
   * No Claude query is invoked for the recipient — the message arrives as-is.
   * A pending note is queued so the recipient's next Claude turn knows context.
   */
  async sendToSession(target: string, text: string): Promise<SendResult> {
    const resolved = this.resolveSendTarget(target);
    if (!resolved) {
      return { ok: false, error: `Unknown target "${target}". Call list_sessions to see valid identities and groups.` };
    }
    const { sessionKey, replyTarget } = resolved;

    const channel = this.getChannel(replyTarget.channelName);
    if (!channel) {
      return { ok: false, error: `Channel "${replyTarget.channelName}" is not connected` };
    }

    await channel.send({ chatId: replyTarget.chatId, text });

    this.sessions.append(sessionKey, {
      role: "assistant",
      content: `[proactive] ${text}`,
      channel: replyTarget.channelName,
      timestamp: Date.now(),
    });

    this.queuePendingNote(sessionKey, `[System: You proactively sent the following message to this conversation earlier (initiated from another session): "${text}"]`);

    log.info({ sessionKey, channel: replyTarget.channelName, chars: text.length }, "Proactive message sent (direct)");
    return { ok: true };
  }

  /**
   * Delegate mode: queue a system request for the target session's Claude to
   * compose and send a message in its own voice/context. Fire-and-forget — the
   * caller's tool result returns as soon as the request is dispatched, not when
   * the recipient's Claude finishes. The user observes the actual outcome in
   * the recipient channel directly (since they're a participant).
   *
   * Note: delegate-to-self isn't blocked here. If it happens, the system
   * request is just queued behind the current turn via enqueueForSession —
   * one extra Claude turn fires, no infinite loop. For mid-loop self-progress
   * updates, prefer direct mode (no extra turn).
   */
  async delegateToSession(target: string, request: string): Promise<SendResult> {
    const resolved = this.resolveSendTarget(target);
    if (!resolved) {
      return { ok: false, error: `Unknown target "${target}". Call list_sessions to see valid identities and groups.` };
    }
    const { sessionKey, replyTarget } = resolved;

    if (!this.getChannel(replyTarget.channelName)) {
      return { ok: false, error: `Channel "${replyTarget.channelName}" is not connected` };
    }

    const systemMsg = `[System: From your other conversation, you were asked to: ${request}. Use this conversation's context, tone, and participants to respond appropriately. Reply NO_REPLY if you judge it shouldn't be sent.]`;

    // Fire-and-forget — handleCronMessage enqueues per session and runs through
    // a normal Claude turn. The user verifies the outcome in the channel.
    this.handleCronMessage(systemMsg, sessionKey).catch((err) => {
      log.error({ err, sessionKey }, "Delegated send failed");
    });

    log.info({ sessionKey, channel: replyTarget.channelName, chars: request.length }, "Proactive message dispatched (delegate)");
    return { ok: true };
  }

  /** Resolve a send_message `target` (identity name or session key) to (sessionKey, replyTarget). */
  private resolveSendTarget(target: string): { sessionKey: string; replyTarget: ReplyTarget } | undefined {
    // Identity name (no colon) → dm:<name>
    if (!target.includes(":")) {
      const identity = config.identities.find((i) => i.name === target);
      if (!identity) return undefined;
      const sessionKey = `dm:${identity.name}`;
      const replyTarget = this.router.getReplyTarget(sessionKey)
        ?? this.router.deriveReplyTargetFromConfig(identity.name);
      return replyTarget ? { sessionKey, replyTarget } : undefined;
    }
    // Session key form (dm:<name> or <channel>:<chatId>)
    // Use parseRawChannelKey, NOT parseChannelKey — the latter rejects group
    // chats by design (it's for sendNotification's "find any DM" fallback).
    // Here the caller explicitly named a target; honor it even if it's a group.
    const replyTarget = this.router.getReplyTarget(target)
      ?? (target.startsWith("dm:") ? this.router.deriveReplyTargetFromConfig(target.slice(3)) : undefined)
      ?? this.parseRawChannelKey(target);
    return replyTarget ? { sessionKey: target, replyTarget } : undefined;
  }

  /** Parse a "<channel>:<chatId>" key into a ReplyTarget. Group-friendly; for
   *  explicit-target paths only. Use parseChannelKey for notification fallbacks. */
  private parseRawChannelKey(key: string): ReplyTarget | undefined {
    if (key.startsWith("dm:")) return undefined;
    const colonIdx = key.indexOf(":");
    if (colonIdx < 0) return undefined;
    const channelName = key.slice(0, colonIdx);
    const chatId = key.slice(colonIdx + 1);
    if (!channelName || !chatId) return undefined;
    return { channelName, chatId };
  }

  /** Catalog of valid send_message targets, with friendly metadata for groups. Backs the `list_sessions` tool. */
  listSessionCatalog(): SessionCatalog {
    const identities = config.identities.map((i) => ({ name: i.name }));
    const groups: SessionCatalog["groups"] = [];
    for (const [key] of this.sessions.listSdkSessionIds()) {
      if (!isGroupSessionKey(key)) continue;
      const entry = this.sessions.getEntry(key);
      groups.push({
        key,
        ...(entry?.chatTitle ? { title: entry.chatTitle } : {}),
        ...(entry?.participants && entry.participants.length > 0 ? { participants: entry.participants } : {}),
      });
    }
    return { identities, groups };
  }

  private queuePendingNote(sessionKey: string, note: string): void {
    const arr = this.pendingNotes.get(sessionKey) ?? [];
    arr.push(note);
    this.pendingNotes.set(sessionKey, arr);
  }

  /** Drain notes queued for this session (e.g. by sendToSession) and return them as a prefix. */
  private drainPendingNotes(sessionKey: string): string {
    const notes = this.pendingNotes.get(sessionKey);
    if (!notes || notes.length === 0) return "";
    this.pendingNotes.delete(sessionKey);
    return notes.map((n) => `${n}\n\n`).join("");
  }

  /** Send a direct notification to the user's DM channel (no agent query) */
  async sendNotification(text: string): Promise<void> {
    const dmKey = this.router.findFirstDmSession();
    let target: ReplyTarget | undefined;

    if (dmKey) {
      target = this.router.getReplyTarget(dmKey)
        ?? (dmKey.startsWith("dm:") ? this.router.deriveReplyTargetFromConfig(dmKey.slice(3)) : undefined)
        ?? this.parseChannelKey(dmKey);
    }

    if (!target) {
      // No identity session — find the first DM (non-group) session across all channels
      for (const [key] of this.sessions.listSdkSessionIds()) {
        const parsed = this.parseChannelKey(key);
        if (parsed) { target = parsed; break; }
      }
    }

    if (!target) { log.debug("Notification: no active DM session"); return; }

    const channel = this.getChannel(target.channelName);
    if (!channel) return;

    await channel.send({ chatId: target.chatId, text });
  }

  async start(): Promise<void> {
    log.info({ channels: this.channels.length }, "Starting Tomo");
    await Promise.all(this.channels.map((ch) => ch.start()));
    log.info("Tomo is running");

    // Check for restart reason and notify via continuity-style message
    if (existsSync(RESTART_REASON_FILE)) {
      const reason = readFileSync(RESTART_REASON_FILE, "utf-8").trim();
      try { unlinkSync(RESTART_REASON_FILE); } catch { /* ignore */ }
      if (reason) {
        log.info({ reason }, "Restart reason found, notifying agent");
        this.handleContinuity(`System: Restarted. Reason: ${reason}`).catch((err) =>
          log.error({ err }, "Failed to send restart reason")
        );
      }
    }
  }

  async stop(): Promise<void> {
    log.info("Shutting down");
    for (const [, s] of this.liveSessions) s.close();
    this.liveSessions.clear();
    await Promise.all(this.channels.map((ch) => ch.stop()));
  }
}
