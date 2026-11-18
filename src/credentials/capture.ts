import type { Channel } from "../channels/types.js";
import { log } from "../logger.js";
import type { CaptureChannel, CredentialRequestView } from "./broker.js";

/** What the web channel offers the broker (src/channels/web.ts). */
export interface CredentialCard {
  publishCredentialRequest(request: CredentialRequestView | null): void;
}

/**
 * The web UI: a password card, opened and withdrawn over the event stream
 * (`credential-request`). The value comes back through `broker.fulfill`, on its
 * own route, so there is no chat prompt and nothing to notify.
 */
export function webCaptureChannel(card: CredentialCard): CaptureChannel {
  return {
    name: "web",
    kind: "form",
    open: async (view) => card.publishCredentialRequest(view),
    close: () => card.publishCredentialRequest(null),
    notify: async () => {},
  };
}

/**
 * iMessage or Telegram: the prompt goes to the owner's private chat the turn
 * came in on, and their next typed message there is the value.
 */
export function chatCaptureChannel(channel: Channel, chatId: string): CaptureChannel {
  const send = (text: string) => channel.send({ chatId, text });
  return {
    name: channel.name,
    kind: "message",
    open: async (_view, prompt) => { await send(prompt); },
    close: () => {},
    notify: async (text) => {
      try { await send(text); } catch { log.warn({ channel: channel.name }, "Could not send a credential notice"); }
    },
  };
}

/** The channels a credential can be asked on. */
export function captureChannelFor(channel: Channel | undefined, chatId: string): CaptureChannel | null {
  if (!channel) return null;
  if (channel.name === "web") {
    const card = channel as Channel & Partial<CredentialCard>;
    return typeof card.publishCredentialRequest === "function" ? webCaptureChannel(card as CredentialCard) : null;
  }
  return channel.name === "imessage" || channel.name === "telegram" ? chatCaptureChannel(channel, chatId) : null;
}
