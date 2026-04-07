import { query } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "crypto";
import type { Channel, IncomingMessage } from "./channels/types.js";
import { config } from "./config.js";
import { buildSystemPrompt } from "./workspace/index.js";
import { SessionStore } from "./sessions/index.js";
import { log } from "./logger.js";

const QUERY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const GROUP_PARTICIPANT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const SILENT_TOKEN = "NO_REPLY";

function isSilentReply(text: string): boolean {
  return /^\s*NO_REPLY\s*$/i.test(text);
}

function sdkOptions(resumeSessionId?: string) {
  return {
    model: config.model,
    cwd: config.workspaceDir,
    systemPrompt: buildSystemPrompt(),
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    allowedTools: [
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "Agent",
      "NotebookEdit",
      "TodoWrite",
      "Skill",
    ],
    settingSources: ["project"] as ("project")[],
    maxTurns: 30,
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
  };
}

export class Agent {
  private channels: Channel[] = [];
  private sessions: SessionStore;
  /** Tracks known participants per group session */
  private groupParticipants = new Map<string, Set<string>>();
  private lastPromptHash: string = "";

  constructor() {
    this.sessions = new SessionStore(config.sessionsDir, config.historyLimit);
  }

  addChannel(channel: Channel): void {
    channel.onMessage((msg) => this.handleMessage(channel, msg));
    channel.onCommand((cmd, chatId, senderName) => this.handleCommand(channel, cmd, chatId, senderName));
    this.channels.push(channel);
  }

  private async handleCommand(channel: Channel, command: string, chatId: string, senderName: string): Promise<void> {
    if (command === "new") {
      const key = this.sessionKey(channel, chatId);
      this.sessions.clearSdkSessionId(key);
      log.info({ channel: channel.name, chatId, sender: senderName }, "New session started via /new");
      await channel.send({ chatId, text: "New session started." });
    }
  }

  private sessionKey(channel: Channel, chatId: string): string {
    return `${channel.name}:${chatId}`;
  }

  private checkPromptChanged(): boolean {
    const currentHash = this.hashString(buildSystemPrompt());
    if (this.lastPromptHash && currentHash !== this.lastPromptHash) {
      log.info("System prompt changed, new sessions will use updated prompt");
      this.lastPromptHash = currentHash;
      return true;
    }
    this.lastPromptHash = currentHash;
    return false;
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

    const key = this.sessionKey(channel, message.chatId);

    // In groups, prefix with sender name so the agent knows who's talking
    const textForAgent = isGroup ? `${message.senderName}: ${message.text}` : message.text;

    // Track group participants and inject context when needed
    if (isGroup) {
      await this.updateGroupContext(key, message.senderName, message.chatTitle);
    }

    this.sessions.append(key, {
      role: "user",
      content: textForAgent,
      channel: channel.name,
      senderName: message.senderName,
      timestamp: message.timestamp,
    });

    // In groups, only respond when mentioned or replied to
    if (isGroup && !isMentioned) {
      log.debug("Group message ignored (not mentioned)");
      return;
    }

    const stopTyping = channel.startTyping(message.chatId);

    try {
      const stampedText = this.injectTimestamp(textForAgent);
      const response = await this.run(key, stampedText, message.images);
      stopTyping();

      this.sessions.append(key, {
        role: "assistant",
        content: response,
        channel: channel.name,
        timestamp: Date.now(),
      });

      log.info({ channel: channel.name }, "Tomo: %s", response);

      if (isSilentReply(response)) {
        log.info("Silent reply (no message sent)");
        return;
      }

      await channel.send({
        chatId: message.chatId,
        text: response,
        replyTo: message.id,
      });
    } catch (err) {
      stopTyping();
      log.error({ err }, "Error handling message");
      await channel.send({
        chatId: message.chatId,
        text: "Sorry, something went wrong. Please try again.",
        replyTo: message.id,
      });
    }
  }

  private async run(sessionKey: string, userMessage: string, images?: import("./channels/types.js").ImageAttachment[], isRetry = false): Promise<string> {
    this.checkPromptChanged();

    const resumeId = this.sessions.getSdkSessionId(sessionKey);
    const opts = sdkOptions(resumeId ?? undefined);
    const parts: string[] = [];

    // For images, prepend image description request
    // V1 query() only takes string prompt, not content blocks
    // TODO: support multimodal via raw API if needed
    const prompt = images && images.length > 0
      ? `[User sent an image${userMessage !== "[Sent an image]" ? ` with caption: ${userMessage}` : ""}]`
      : userMessage;

    log.debug({ sessionKey, resume: !!resumeId }, "Running query");

    try {
      for await (const event of query({ prompt, options: opts })) {
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if ("text" in block) {
              parts.push(block.text);
            } else if ("type" in block && block.type === "tool_use") {
              const tool = block as { name: string; input?: Record<string, unknown> };
              const summary = this.summarizeToolInput(tool.name, tool.input);
              log.info({ tool: tool.name }, summary);
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
            modelUsage?: Record<string, { inputTokens: number; outputTokens: number; contextWindow: number }>;
          };

          // Capture session ID for future resume
          if (result.session_id) {
            if (!this.sessions.getSdkSessionId(sessionKey)) {
              this.sessions.setSdkSessionId(sessionKey, result.session_id);
              log.info({ sessionId: result.session_id, key: sessionKey }, "Session ID captured");
            } else {
              this.sessions.touchSession(sessionKey);
            }
          }

          const u = result.usage as Record<string, number> | undefined;
          const input = u?.input_tokens ?? 0;
          const output = u?.output_tokens ?? 0;
          const cacheRead = u?.cache_read_input_tokens ?? 0;
          const cacheCreated = u?.cache_creation_input_tokens ?? 0;
          const model = result.modelUsage ? Object.values(result.modelUsage)[0] : undefined;
          const contextWindow = model?.contextWindow ?? 0;
          const used = (model?.inputTokens ?? 0) + (model?.outputTokens ?? 0);
          const remaining = contextWindow - used;
          const usage_pct = contextWindow > 0 ? Math.round((used / contextWindow) * 100) : 0;

          if (contextWindow > 0 && used >= contextWindow * 0.8) {
            log.warn(
              { used, contextWindow, pct: `${usage_pct}%` },
              "Context nearing compaction threshold",
            );
          }

          log.info(
            {
              turns: result.num_turns,
              duration: `${result.duration_ms}ms`,
              cost: `$${result.total_cost_usd?.toFixed(4)}`,
              tokens: `in:${input} out:${output}`,
              cache: `read:${cacheRead} created:${cacheCreated}`,
              context: `${used}/${contextWindow} (${remaining} remaining, ${usage_pct}%)`,
            },
            "Run completed (%s)", result.subtype,
          );
        }
      }

      return parts.join("\n").trim() || "I'm not sure how to respond to that.";
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "";
      const isSessionError = errMsg.includes("No conversation found") || errMsg.includes("session");
      const isMaxTurns = errMsg.includes("maximum number of turns");

      if (isMaxTurns) {
        // Max turns is not a session error — return whatever we have so far
        log.warn("Hit max turns, returning partial response");
        return parts.join("\n").trim() || "I ran out of steps trying to complete that. Can you try a simpler request?";
      }

      if (!isRetry && resumeId && isSessionError) {
        log.warn({ err }, "Session error, resetting and retrying");
        this.sessions.clearSdkSessionId(sessionKey);
        return this.run(sessionKey, userMessage, images, true);
      }
      throw err;
    }
  }

  private async updateGroupContext(key: string, senderName: string, chatTitle?: string): Promise<void> {
    let participants = this.groupParticipants.get(key);
    const isNew = !participants;

    if (!participants) {
      participants = new Set();
      this.groupParticipants.set(key, participants);
    }

    const wasKnown = participants.has(senderName);
    participants.add(senderName);

    // Send context message on first group message or when a new participant appears
    if (isNew || !wasKnown) {
      const names = [...participants].join(", ");
      const title = chatTitle ? `"${chatTitle}"` : "a group chat";
      const contextMsg = `System: You are in ${title}. Participants so far: ${names}. Messages are prefixed with sender names.`;

      // Inject as a query so it becomes part of the session history
      const resumeId = this.sessions.getSdkSessionId(key);
      const opts = sdkOptions(resumeId ?? undefined);
      for await (const event of query({ prompt: contextMsg, options: { ...opts, maxTurns: 3 } })) {
        if (event.type === "result") {
          const result = event as unknown as { session_id?: string };
          if (result.session_id && !this.sessions.getSdkSessionId(key)) {
            this.sessions.setSdkSessionId(key, result.session_id);
          }
        }
      }
      log.info({ group: chatTitle, participants: names }, "Group context updated");
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

  private summarizeToolInput(name: string, input?: Record<string, unknown>): string {
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

  /** Handle a cron-triggered message */
  async handleCronMessage(message: string, channelName?: string, chatId?: string): Promise<void> {
    const channel = channelName
      ? this.channels.find((ch) => ch.name === channelName)
      : this.channels[0];

    if (!channel) {
      log.warn({ channelName }, "Cron: no channel found for delivery");
      return;
    }

    const targetChatId = chatId ?? this.findLastChatId(channel.name);
    if (!targetChatId) {
      log.warn({ channel: channel.name }, "Cron: no chatId available for delivery");
      return;
    }

    const key = this.sessionKey(channel, targetChatId);
    const stampedMessage = this.injectTimestamp(message);

    log.info({ channel: channel.name, sender: "cron" }, message);

    const stopTyping = channel.startTyping(targetChatId);

    try {
      const response = await this.run(key, stampedMessage);
      stopTyping();

      log.info({ channel: channel.name }, "Tomo: %s", response);

      if (isSilentReply(response)) {
        log.info("Cron completed silently (no reply sent)");
        return;
      }

      this.sessions.append(key, {
        role: "assistant",
        content: response,
        channel: channel.name,
        timestamp: Date.now(),
      });

      await channel.send({ chatId: targetChatId, text: response });
    } catch (err) {
      stopTyping();
      log.error({ err }, "Cron message handling failed");
    }
  }

  private findLastChatId(channelName: string): string | undefined {
    // Check SDK session keys for any chat on this channel
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
    await Promise.all(this.channels.map((ch) => ch.stop()));
  }
}
