// An offline TelegramChannel for tests/telegram.test.ts: grammY's `Bot` is
// reached through the channel's private `bot` field, given the identity it
// would normally fetch with `getMe`, and (optionally) a fake Bot API, so the
// channel's REAL handlers run without any network.
import { TelegramChannel, type TelegramChannelOptions } from "../../src/channels/telegram.js";
import type { IncomingMessage } from "../../src/channels/types.js";

/** What `getMe` would answer. `bot.handleUpdate` refuses to run without it. */
export const BOT_INFO = {
  id: 123456, is_bot: true, first_name: "Tomo", username: "tomobot",
  can_join_groups: true, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business_account: false,
  has_main_web_app: false,
} as const;

/** The parts of grammY's Bot the tests drive or replace. */
export interface OfflineBot {
  botInfo: unknown;
  api: Record<string, unknown>;
  init: () => Promise<void>;
  handleUpdate: (update: unknown) => Promise<void>;
}

export function offlineTelegram(options: { api?: Record<string, unknown>; config?: TelegramChannelOptions } = {}) {
  const channel = new TelegramChannel("123456:TEST-TOKEN", options.config);
  const bot = (channel as unknown as { bot: OfflineBot }).bot;
  bot.botInfo = BOT_INFO;
  if (options.api) bot.api = options.api;
  return { channel, bot };
}

/** Run the channel's real `start()` offline: no getMe, no command-menu call,
 *  no polling. This is what loads the bot's username, which group mention
 *  detection needs. */
export async function startOffline(channel: TelegramChannel, bot: OfflineBot): Promise<void> {
  bot.init = async () => { bot.botInfo = BOT_INFO; };
  bot.api.setMyCommands = async () => true;
  (channel as unknown as { startPolling: () => void }).startPolling = () => {};
  await channel.start();
}

export const ALICE = { id: 7, is_bot: false, first_name: "Alice" } as const;
export const PRIVATE_CHAT = { id: 42, type: "private" } as const;

/** One `message` update from Alice in a private chat; `message` overrides
 *  any field (chat, from, text, document, ...). */
export const messageUpdate = (message: Record<string, unknown>, updateId = 1) => ({
  update_id: updateId,
  message: { message_id: 5, date: 1_700_000_000, chat: PRIVATE_CHAT, from: ALICE, ...message },
});

/** Every message the channel hands the agent. */
export function receivedBy(channel: TelegramChannel): IncomingMessage[] {
  const received: IncomingMessage[] = [];
  channel.onMessage(async (msg) => { received.push(msg); return true; });
  return received;
}
