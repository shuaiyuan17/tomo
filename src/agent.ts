import { query, type Query, type SDKUserMessage, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Channel, IncomingMessage } from "./channels/types.js";
import { config } from "./config.js";
import { buildSystemPrompt } from "./workspace/index.js";
import { SessionStore } from "./sessions/index.js";
import { checkAndClearCompactTrigger } from "./lcm/index.js";
import { IdentityRouter } from "./router.js";
import { log } from "./logger.js";

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

function sdkOptions(resumeSessionId?: string, model?: string, sessionContext?: { channelKey: string; sdkSessionId?: string }) {
  let systemPrompt = buildSystemPrompt();

  // Inject session context so the agent can use LCM tools
  if (sessionContext) {
    const lines = [
      "\n\n# SESSION — Current Session Info",
      `- Channel key: ${sessionContext.channelKey}`,
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
    ],
    settingSources: ["project"] as ("project")[],
    includePartialMessages: true,
    maxTurns: 30,
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
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

  constructor(options: ReturnType<typeof sdkOptions>) {
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
          const tool = block as { name: string; input?: Record<string, unknown> };
          log.info({ tool: tool.name }, summarizeToolInput(tool.name, tool.input));
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

    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minute timeout

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
        reject(new Error("Query timed out after 5 minutes"));
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
    this.q.return(undefined);
  }
}

// --- Agent ---

function summarizeToolInput(name: string, input?: Record<string, unknown>): string {
  if (!input) return name;
  switch (name) {
    case "Read": return `Read ${input.file_path}`;
    case "Write": return `Write ${input.file_path}`;
    case "Edit": return `Edit ${input.file_path}`;
    case "Bash": return `Bash: ${String(input.command).slice(0, 80)}`;
    case "Glob": return `Glob ${input.pattern}`;
    case "Grep": return `Grep "${input.pattern}"`;
    case "WebSearch": return `WebSearch: ${input.query}`;
    case "WebFetch": return `WebFetch: ${input.url}`;
    default: return `${name}: ${JSON.stringify(input).slice(0, 100)}`;
  }
}

export class Agent {
  private channels: Channel[] = [];
  private sessions: SessionStore;
  private router: IdentityRouter;
  private liveSessions = new Map<string, LiveSession>();
  private groupParticipants = new Map<string, Set<string>>();
  private modelOverrides = new Map<string, string>();
  private lastPromptHash: string = "";

  constructor() {
    this.sessions = new SessionStore(config.sessionsDir, config.historyLimit);
    this.router = new IdentityRouter(config.identities, this.sessions);

    // Load persistent per-session model overrides
    for (const [key, model] of Object.entries(config.sessionModelOverrides)) {
      this.modelOverrides.set(key, model);
    }
  }

  /** Look up a channel by name */
  private getChannel(name: string): Channel | undefined {
    return this.channels.find((ch) => ch.name === name);
  }

  addChannel(channel: Channel): void {
    channel.onMessage((msg) => this.handleMessage(channel, msg));
    channel.onCommand((cmd, chatId, senderName, args) => this.handleCommand(channel, cmd, chatId, senderName, args));
    this.channels.push(channel);
  }

  private static readonly AVAILABLE_MODELS: Record<string, string> = {
    "sonnet": "claude-sonnet-4-6[1m]",
    "opus": "claude-opus-4-6[1m]",
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
    const opts = sdkOptions(resumeId ?? undefined, model, {
      channelKey: key,
      sdkSessionId: resumeId ?? undefined,
    });

    session = new LiveSession(opts);
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

    if (isGroup && !isMentioned) {
      log.debug("Group message ignored (not mentioned)");
      return;
    }

    // iMessage groups: skip typing indicator (most messages will be NO_REPLY)
    const isImessageGroup = isGroup && channel.name === "imessage";
    const stopTyping = isImessageGroup ? () => {} : replyChannel.startTyping(replyChatId);

    try {
      const stampedText = this.injectTimestamp(textForAgent);

      const stream = replyChannel.createStreamingMessage(replyChatId, isGroup ? message.id : undefined);
      const response = await this.runWithRetry(key, stampedText, (text) => {
        stream.update(text.replace(MEDIA_RE, "").trim());
      }, message.images);
      stopTyping();

      // If context is high, send a system nudge so the agent can compact
      const liveSession = this.liveSessions.get(key);
      const ctx = liveSession?.lastResult;
      if (ctx && ctx.contextMax > 0) {
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

      // iMessage groups: suppress error messages to avoid polluting the chat
      if (isImessageGroup) return;

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

    if (isNew || !wasKnown) {
      const names = [...participants].join(", ");
      const title = chatTitle ? `"${chatTitle}"` : "a group chat";
      let contextMsg = `System: You are in ${title}. Participants so far: ${names}. Messages are prefixed with sender names.`;

      // iMessage groups: inject guidance to stay silent unless needed
      if (isNew && channelName === "imessage") {
        contextMsg += " This is an iMessage group chat. You see every message but should only reply when you have something genuinely useful to add. Reply NO_REPLY to stay silent. Do not respond to casual chatter, greetings, or messages not directed at you.";
      }

      try {
        await this.runWithRetry(key, contextMsg);
        log.info({ group: chatTitle, participants: names }, "Group context updated");
      } catch (err) {
        log.warn({ err }, "Failed to inject group context");
      }
    }
  }

  private injectTimestamp(text: string): string {
    const now = new Date();
    const weekday = now.toLocaleDateString("en-US", { weekday: "short" });
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const date = `${mm}/${dd}`;
    const time = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const tz = now.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
    return `[${weekday} ${date} ${time} ${tz}] ${text}`;
  }

  /** Handle a cron-triggered message */
  async handleCronMessage(message: string, channelName?: string, chatId?: string): Promise<void> {
    // Resolve delivery target
    let key: string;
    let deliveryChannel: Channel;
    let deliveryChatId: string;

    if (channelName && chatId) {
      // Explicit channel+chatId from cron job — resolve through router for identity support
      const resolution = this.router.resolve(channelName, chatId, false);
      key = resolution.sessionKey;
      deliveryChannel = this.getChannel(resolution.replyTarget.channelName) ?? this.channels[0];
      deliveryChatId = resolution.replyTarget.chatId;
    } else {
      // No explicit target — try unified dm session first, then fall back to channel scan
      const dmKey = this.router.findFirstDmSession();
      if (dmKey) {
        key = dmKey;
        const target = this.router.getReplyTarget(dmKey);
        if (target) {
          deliveryChannel = this.getChannel(target.channelName) ?? this.channels[0];
          deliveryChatId = target.chatId;
        } else {
          log.warn("Cron: dm session has no reply target");
          return;
        }
      } else {
        // Legacy fallback: find last active chatId on first channel
        const channel = this.channels[0];
        if (!channel) { log.warn("Cron: no channel available"); return; }
        const fallbackChatId = this.findLastChatId(channel.name);
        if (!fallbackChatId) { log.warn({ channel: channel.name }, "Cron: no chatId available"); return; }
        key = `${channel.name}:${fallbackChatId}`;
        deliveryChannel = channel;
        deliveryChatId = fallbackChatId;
      }
    }

    const stampedMessage = this.injectTimestamp(message);
    log.info({ channel: deliveryChannel.name, sender: "cron" }, message);

    const stopTyping = deliveryChannel.startTyping(deliveryChatId);

    try {
      const response = await this.runWithRetry(key, stampedMessage);
      stopTyping();

      log.info({ channel: deliveryChannel.name }, "Tomo: %s", response);

      if (isSilentReply(response)) {
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

  /** Handle a continuity heartbeat — runs on the first active DM session */
  async handleContinuity(prompt: string): Promise<void> {
    // Prefer unified dm session, then fall back to channel-scoped session
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

    try {
      const response = await this.runWithRetry(key, prompt);
      log.info("Continuity response: %s", response.slice(0, 100));
    } catch (err) {
      log.error({ err }, "Continuity heartbeat failed");
    }
  }

  private findLastChatId(channelName: string): string | undefined {
    for (const [key] of this.sessions.listSdkSessionIds()) {
      if (key.startsWith(`${channelName}:`)) {
        return key.slice(channelName.length + 1);
      }
    }
    return undefined;
  }

  async start(): Promise<void> {
    log.info({ channels: this.channels.length }, "Starting Tomo");
    await Promise.all(this.channels.map((ch) => ch.start()));
    log.info("Tomo is running");
  }

  async stop(): Promise<void> {
    log.info("Shutting down");
    for (const [, s] of this.liveSessions) s.close();
    this.liveSessions.clear();
    await Promise.all(this.channels.map((ch) => ch.stop()));
  }
}
