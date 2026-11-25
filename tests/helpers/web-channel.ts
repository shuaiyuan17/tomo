import { afterEach, vi } from "vitest";
import { WebChannel } from "../../src/channels/web.js";
import { WatchBus } from "../../src/watch/bus.js";
import type { OwnerConfig } from "../../src/owner.js";
import type { WebEvent } from "../../src/web/protocol.js";

/** The owner every web test uses unless it needs another. */
export const TEST_OWNER: OwnerConfig = { name: "owner", telegram: ["test-owner"], imessage: [] };

export type WebChannelOptions = NonNullable<ConstructorParameters<typeof WebChannel>[2]>;
export interface TestWebChannel {
  channel: WebChannel;
  bus: WatchBus;
  /** The Agent's side: accepts every message. */
  handler: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<boolean>>>;
  /** Every event the channel published, in order. */
  events: WebEvent[];
}

/**
 * Call once at a test file's top level (or in a describe): returns a factory
 * for WebChannels on their own WatchBus, and stops every channel it made
 * after each test.
 */
export function useWebChannels(): (options?: WebChannelOptions, owner?: OwnerConfig | null) => TestWebChannel {
  const made: WebChannel[] = [];
  afterEach(async () => { for (const channel of made.splice(0)) await channel.stop(); });
  return (options = {}, owner = TEST_OWNER) => {
    const bus = new WatchBus();
    const channel = new WebChannel(owner ?? undefined, bus, options);
    made.push(channel);
    const handler = vi.fn(async (..._args: unknown[]) => true);
    channel.onMessage(handler);
    const events: WebEvent[] = [];
    channel.events.subscribe(({ event }) => events.push(event));
    return { channel, bus, handler, events };
  };
}
