import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import type { Channel } from "../channels/types.js";
import { shortErrorMessage } from "../error-text.js";
import { log } from "../logger.js";
import type { ReplyTarget } from "../sessions/types.js";
import { joinText, ownerT, raw, type OwnerText } from "../i18n/index.js";

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

  /** Every message here goes to the owner's private chat. */
  private async say(channel: Channel, chatId: string, text: OwnerText): Promise<void> {
    await channel.send({ chatId, text });
  }

  async forwardMcpAuthorizeUrl(key: string, serverName: string, url: string): Promise<void> {
    const target = this.resolvePrivateReplyTarget(key);
    if (!target) throw new Error(`No private reply target is available for MCP OAuth login (${serverName})`);
    const channel = this.getChannel(target.channelName);
    if (!channel) throw new Error(`Channel "${target.channelName}" is not connected for MCP OAuth login (${serverName})`);

    const t = ownerT("notices");
    await this.say(channel, target.chatId, joinText([t("mcpOAuth.authorize", { server: serverName }), raw(url), t("mcpOAuth.authorizeInstructions")]));
  }

  async handleMcpAuthFailure(serverName: string, err: unknown): Promise<void> {
    const detail = shortErrorMessage(err);
    log.warn({ serverName, err }, "External MCP server omitted after OAuth failure");

    const target = this.findPrivateReplyTarget();
    if (!target) return;
    const channel = this.getChannel(target.channelName);
    if (!channel) return;

    await this.say(channel, target.chatId, ownerT("notices")("mcpOAuth.failed", { server: serverName, error: detail }));
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

    const t = ownerT("notices");
    if (request.mode === "url" && request.url) {
      // The server's own message and link are passed through as it wrote them.
      const lines = [t("mcpOAuth.elicitation", { server: request.serverName }), ...(request.message ? [raw(request.message)] : []), raw(request.url), t("mcpOAuth.elicitationInstructions")];
      await this.say(channel, target.chatId, joinText(lines));
      log.info({ key, server: request.serverName }, "Forwarded MCP login URL to user");
      return { action: "accept" };
    }

    await this.say(channel, target.chatId, t("mcpOAuth.unsupported", { server: request.serverName }));
    log.warn({ key, server: request.serverName, mode: request.mode }, "Declined unsupported MCP elicitation");
    return { action: "decline" };
  }
}
