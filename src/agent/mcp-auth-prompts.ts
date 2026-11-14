import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import type { Channel } from "../channels/types.js";
import { shortErrorMessage } from "../error-text.js";
import { log } from "../logger.js";
import type { ReplyTarget } from "../sessions/types.js";

export interface McpAuthPromptsDeps {
  resolvePrivateReplyTarget(key: string): ReplyTarget | undefined;
  findPrivateReplyTarget(): ReplyTarget | undefined;
  getChannel(name: string): Channel | undefined;
}

/**
 * Chat messages for external MCP OAuth: the login link, an OAuth failure, and
 * SDK elicitation requests. Always sent to a private reply target.
 */
export class McpAuthPrompts {
  constructor(private readonly deps: McpAuthPromptsDeps) {}

  private resolvePrivateReplyTarget(key: string): ReplyTarget | undefined {
    return this.deps.resolvePrivateReplyTarget(key);
  }

  private findPrivateReplyTarget(): ReplyTarget | undefined {
    return this.deps.findPrivateReplyTarget();
  }

  private getChannel(name: string): Channel | undefined {
    return this.deps.getChannel(name);
  }

  async forwardMcpAuthorizeUrl(key: string, serverName: string, url: string): Promise<void> {
    const target = this.resolvePrivateReplyTarget(key);
    if (!target) throw new Error(`No private reply target is available for MCP OAuth login (${serverName})`);
    const channel = this.getChannel(target.channelName);
    if (!channel) throw new Error(`Channel "${target.channelName}" is not connected for MCP OAuth login (${serverName})`);

    await channel.send({
      chatId: target.chatId,
      text: [
        `MCP login required for ${serverName}.`,
        "",
        url,
        "",
        "Open the link and finish login. If the browser is on another device, paste the full localhost redirect URL back into this private DM so Tomo can complete the callback.",
        "The current turn will continue without this server. After login, Tomo will attach it to live sessions automatically; if runtime hot-mounting is unavailable, the next session will use it.",
      ].join("\n"),
    });
  }

  async handleMcpAuthFailure(serverName: string, err: unknown): Promise<void> {
    const detail = shortErrorMessage(err);
    log.warn({ serverName, err }, "External MCP server omitted after OAuth failure");

    const target = this.findPrivateReplyTarget();
    if (!target) return;
    const channel = this.getChannel(target.channelName);
    if (!channel) return;

    await channel.send({
      chatId: target.chatId,
      text: `MCP server "${serverName}" is unavailable because OAuth failed or timed out: ${detail}. Continuing without that server.`,
    });
  }

  async handleMcpElicitation(key: string, request: ElicitationRequest): Promise<ElicitationResult> {
    const target = this.resolvePrivateReplyTarget(key);
    if (!target) {
      log.warn({ key, server: request.serverName }, "MCP elicitation requested but no private reply target is available");
      return { action: "decline" };
    }

    const channel = this.getChannel(target.channelName);
    if (!channel) {
      log.warn({ key, channelName: target.channelName, server: request.serverName }, "MCP elicitation requested but channel is not connected");
      return { action: "decline" };
    }

    if (request.mode === "url" && request.url) {
      const lines = [
        `MCP login required for ${request.serverName}.`,
        request.message,
        "",
        request.url,
        "",
        "Open the link and finish login. If Tomo does not continue automatically, retry your request after login completes.",
      ];
      await channel.send({ chatId: target.chatId, text: lines.filter(Boolean).join("\n") });
      log.info({ key, server: request.serverName }, "Forwarded MCP login URL to user");
      return { action: "accept" };
    }

    await channel.send({
      chatId: target.chatId,
      text: `MCP server ${request.serverName} requested additional input, but Tomo can only forward browser login links right now.`,
    });
    log.warn({ key, server: request.serverName, mode: request.mode }, "Declined unsupported MCP elicitation");
    return { action: "decline" };
  }
}
