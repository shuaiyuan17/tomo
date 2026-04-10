import { createServer, type Server, type IncomingMessage as HttpRequest, type ServerResponse } from "node:http";
import type { Channel, IncomingMessage, OutgoingMessage, MessageHandler, CommandHandler, StreamingMessage } from "./types.js";
import { log } from "../logger.js";

const TEXT_CHUNK_LIMIT = 4000;

interface BlueBubblesConfig {
  url: string;
  password: string;
  webhookPort: number;
}

export class BlueBubblesChannel implements Channel {
  readonly name = "imessage";
  private handlers: MessageHandler[] = [];
  private commandHandlers: CommandHandler[] = [];
  private server: Server | null = null;
  private webhookId: number | null = null;
  private apiUrl: string;
  private password: string;
  private webhookPort: number;
  private contactCache = new Map<string, string>(); // address → display name

  constructor(config: BlueBubblesConfig) {
    this.apiUrl = config.url.replace(/\/+$/, "");
    this.password = config.password;
    this.webhookPort = config.webhookPort;
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  onCommand(handler: CommandHandler): void {
    this.commandHandlers.push(handler);
  }

  async start(): Promise<void> {
    log.info("iMessage channel starting");

    // Verify BlueBubbles server is reachable
    try {
      await this.api("GET", "/ping");
      log.info("BlueBubbles server connected");
    } catch (err) {
      log.error({ err }, "Failed to connect to BlueBubbles server at %s", this.apiUrl);
      throw new Error(`BlueBubbles server unreachable at ${this.apiUrl}`, { cause: err });
    }

    // Load contacts for name resolution
    await this.loadContacts();

    // Start webhook HTTP server
    await this.startWebhookServer();

    // Register webhook with BlueBubbles
    await this.registerWebhook();

    log.info("iMessage channel ready");
  }

  async stop(): Promise<void> {
    log.info("iMessage channel stopping");

    // Unregister webhook
    if (this.webhookId !== null) {
      try {
        await this.api("DELETE", `/webhook/${this.webhookId}`);
        log.info("Webhook unregistered");
      } catch {
        log.warn("Failed to unregister webhook");
      }
    }

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (message.photo) {
      await this.sendAttachment(message.chatId, message.photo, message.text);
      return;
    }

    const text = message.text;
    if (!text) return;

    // Split long messages
    const chunks = this.splitText(text, TEXT_CHUNK_LIMIT);
    for (const chunk of chunks) {
      await this.api("POST", "/message/text", {
        chatGuid: message.chatId,
        tempGuid: `tomo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        message: chunk,
        method: "apple-script",
      });
    }
  }

  createStreamingMessage(chatId: string, _replyTo?: string): StreamingMessage {
    // iMessage can't edit sent messages — buffer and send on finish
    let buffer = "";

    return {
      update: (text: string) => {
        buffer = text;
      },
      finish: async () => {
        if (buffer) {
          await this.send({ chatId, text: buffer });
        }
      },
    };
  }

  startTyping(chatId: string): () => void {
    // Typing indicators require BlueBubbles Private API
    // Best-effort: try and silently ignore failure
    let sealed = false;
    const INTERVAL_MS = 6000;
    const TTL_MS = 2 * 60 * 1000;

    const sendTyping = () => {
      if (sealed) return;
      this.api("POST", `/chat/${encodeURIComponent(chatId)}/typing`).catch(() => {});
    };

    sendTyping();
    const interval = setInterval(sendTyping, INTERVAL_MS);
    const ttl = setTimeout(() => cleanup(), TTL_MS);

    const cleanup = () => {
      if (sealed) return;
      sealed = true;
      clearInterval(interval);
      clearTimeout(ttl);
      // Stop typing indicator
      this.api("DELETE", `/chat/${encodeURIComponent(chatId)}/typing`).catch(() => {});
    };

    return cleanup;
  }

  // --- Webhook server ---

  private async startWebhookServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleWebhookRequest(req, res));

      this.server.on("error", (err) => {
        log.error({ err }, "Webhook server error");
        reject(err);
      });

      this.server.listen(this.webhookPort, () => {
        log.info({ port: this.webhookPort }, "Webhook server listening");
        resolve();
      });
    });
  }

  private handleWebhookRequest(req: HttpRequest, res: ServerResponse): void {
    if (req.method !== "POST" || !req.url?.startsWith("/bluebubbles/webhook")) {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok"}');

      try {
        const payload = JSON.parse(body);
        this.handleWebhookEvent(payload).catch((err) => {
          log.error({ err }, "Error processing webhook event");
        });
      } catch {
        log.warn("Invalid webhook payload");
      }
    });
  }

  private async registerWebhook(): Promise<void> {
    const webhookUrl = `http://localhost:${this.webhookPort}/bluebubbles/webhook`;

    try {
      // Clean up existing webhooks for our URL
      const existing = await this.api("GET", "/webhook");
      const webhooks = (existing?.data ?? []) as Array<{ id: number; url: string }>;
      for (const wh of webhooks) {
        if (wh.url === webhookUrl) {
          await this.api("DELETE", `/webhook/${wh.id}`);
        }
      }

      // Register new webhook
      const result = await this.api("POST", "/webhook", {
        url: webhookUrl,
        events: ["new-message"],
      });
      const resultData = result?.data as { id: number } | undefined;
      this.webhookId = resultData?.id ?? null;
      log.info({ webhookId: this.webhookId, url: webhookUrl }, "Webhook registered");
    } catch (err) {
      log.error({ err }, "Failed to register webhook");
      throw err;
    }
  }

  // --- Webhook event handling ---

  private async handleWebhookEvent(payload: Record<string, unknown>): Promise<void> {
    if (payload.type !== "new-message") return;

    const data = payload.data as Record<string, unknown>;
    if (!data) return;

    // Skip messages from self (prevent echo loop)
    if (data.isFromMe) return;

    const text = (data.text as string) ?? "";
    const guid = data.guid as string;

    // Resolve chat info
    const chats = data.chats as Array<Record<string, unknown>> | undefined;
    const chat = chats?.[0];
    if (!chat) return;

    const chatGuid = chat.guid as string;
    if (!chatGuid) return;

    // Determine if group chat (iMessage;+; = group, iMessage;-; or SMS;-; = DM)
    const isGroup = chatGuid.includes(";+;");

    // Get sender info
    const handle = data.handle as Record<string, unknown> | undefined;
    const senderAddress = (handle?.address as string) ?? "Unknown";

    // iMessage has no @mention system — treat all group messages as mentioned
    // (the agent gets a one-time system prompt to stay silent unless it has something to say)
    const isMentioned = isGroup;

    // Handle slash commands
    if (text.startsWith("/")) {
      const parts = text.slice(1).split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1).join(" ");
      if (command === "new" || command === "model" || command === "status") {
        for (const handler of this.commandHandlers) {
          await handler(command, chatGuid, senderAddress, args);
        }
        return;
      }
    }

    // Download image attachments
    const attachments = data.attachments as Array<Record<string, unknown>> | undefined;
    const images = await this.downloadAttachments(attachments);

    // Mark chat as read (best-effort; requires BlueBubbles Private API helper)
    this.api("POST", `/chat/${encodeURIComponent(chatGuid)}/read`).catch(() => {});

    const senderName = this.resolveContactName(senderAddress);

    const message: IncomingMessage = {
      id: guid,
      chatId: chatGuid,
      senderName,
      text: text || (images.length > 0 ? "[Sent an image]" : ""),
      images: images.length > 0 ? images : undefined,
      timestamp: typeof data.dateCreated === "number" ? data.dateCreated : Date.now(),
      isGroup,
      isMentioned,
      chatTitle: (chat.displayName as string) ?? undefined,
    };

    for (const handler of this.handlers) {
      await handler(message);
    }
  }

  private async downloadAttachments(
    attachments: Array<Record<string, unknown>> | undefined,
  ): Promise<Array<{ data: string; mediaType: string }>> {
    if (!attachments || attachments.length === 0) return [];

    const images: Array<{ data: string; mediaType: string }> = [];

    for (const att of attachments) {
      const mimeType = att.mimeType as string | undefined;
      if (!mimeType?.startsWith("image/")) continue;

      const attGuid = att.guid as string;
      if (!attGuid) continue;

      try {
        const url = `${this.apiUrl}/api/v1/attachment/${encodeURIComponent(attGuid)}/download?password=${encodeURIComponent(this.password)}`;
        const res = await fetch(url);
        if (!res.ok) continue;

        const buffer = Buffer.from(await res.arrayBuffer());
        images.push({
          data: buffer.toString("base64"),
          mediaType: mimeType,
        });
      } catch (err) {
        log.error({ err, guid: attGuid }, "Failed to download attachment");
      }
    }

    return images;
  }

  // --- Contact resolution ---

  private async loadContacts(): Promise<void> {
    try {
      const result = await this.api("GET", "/contact");
      const contacts = (result?.data ?? []) as Array<Record<string, unknown>>;

      for (const contact of contacts) {
        const firstName = (contact.firstName as string) ?? "";
        const lastName = (contact.lastName as string) ?? "";
        const displayName = [firstName, lastName].filter(Boolean).join(" ");
        if (!displayName) continue;

        // Map all phone numbers and emails for this contact
        const phoneNumbers = (contact.phoneNumbers ?? []) as Array<Record<string, unknown>>;
        const emails = (contact.emails ?? []) as Array<Record<string, unknown>>;

        for (const phone of phoneNumbers) {
          const addr = phone.address as string | undefined;
          if (addr) this.contactCache.set(this.normalizeAddress(addr), displayName);
        }
        for (const email of emails) {
          const addr = email.address as string | undefined;
          if (addr) this.contactCache.set(addr.toLowerCase(), displayName);
        }
      }

      log.info({ contacts: this.contactCache.size }, "Contacts loaded");
    } catch (err) {
      log.warn({ err }, "Failed to load contacts, will use raw addresses");
    }
  }

  private resolveContactName(address: string): string {
    return this.contactCache.get(this.normalizeAddress(address)) ?? address;
  }

  /** Normalize phone number: strip non-digits except leading + */
  private normalizeAddress(addr: string): string {
    if (addr.includes("@")) return addr.toLowerCase();
    return addr.replace(/[^\d+]/g, "");
  }

  // --- BlueBubbles API ---

  private async api(method: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${this.apiUrl}/api/v1${path}${separator}password=${encodeURIComponent(this.password)}`;

    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`BlueBubbles API ${method} ${path} returned ${res.status}: ${text}`);
    }

    return res.json() as Promise<Record<string, unknown>>;
  }

  private async sendAttachment(chatGuid: string, filePath: string, caption?: string): Promise<void> {
    const { readFileSync, existsSync: fileExists } = await import("node:fs");
    const { basename } = await import("node:path");

    if (!fileExists(filePath)) {
      log.warn({ path: filePath }, "Attachment file not found");
      return;
    }

    const fileData = readFileSync(filePath);
    const fileName = basename(filePath);

    // Build multipart form data manually
    const boundary = `----TomoFormBoundary${Date.now()}`;
    const parts: Buffer[] = [];

    // chatGuid field
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chatGuid"\r\n\r\n${chatGuid}\r\n`));

    // tempGuid field
    const tempGuid = `tomo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="tempGuid"\r\n\r\n${tempGuid}\r\n`));

    // name field
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${fileName}\r\n`));

    // file field
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(fileData);
    parts.push(Buffer.from("\r\n"));

    // End boundary
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    const url = `${this.apiUrl}/api/v1/message/attachment?password=${encodeURIComponent(this.password)}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.error({ status: res.status, response: text }, "Failed to send attachment");
    }

    // Send caption as separate message if present
    if (caption) {
      await this.send({ chatId: chatGuid, text: caption });
    }
  }

  private splitText(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        chunks.push(remaining);
        break;
      }
      // Try to split at a newline or space
      let splitAt = remaining.lastIndexOf("\n", limit);
      if (splitAt < limit * 0.5) splitAt = remaining.lastIndexOf(" ", limit);
      if (splitAt < limit * 0.5) splitAt = limit;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }
}
