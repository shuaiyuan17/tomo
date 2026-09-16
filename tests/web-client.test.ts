import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sendMessage } from "../web/src/api.js";
import type { WebBootstrap } from "../src/web/protocol.js";

afterEach(() => vi.unstubAllGlobals());
const bootstrap = { csrfToken: "old", epoch: "test-epoch" } as WebBootstrap;
const input = { requestId: randomUUID(), text: "test" };
it.each([[403, "invalid_csrf"], [403, "invalid_origin"], [503, "service_unavailable"]])("limits retry for %s %s", async (status, code) => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: code }), { status }));
  vi.stubGlobal("fetch", fetch);
  const refresh = vi.fn(async () => ({ ...bootstrap, csrfToken: "new" }));
  await expect(sendMessage(input, bootstrap, refresh)).rejects.toMatchObject({ status, code });
  expect(fetch).toHaveBeenCalledTimes(code === "invalid_csrf" ? 2 : 1);
  expect(refresh).toHaveBeenCalledTimes(code === "invalid_csrf" ? 1 : 0);
});
it("does not retry a network failure or silently switch daemon epochs", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error("connection lost")); vi.stubGlobal("fetch", fetch);
  const refresh = vi.fn(async () => ({ ...bootstrap, epoch: "new-epoch" }));
  await expect(sendMessage(input, bootstrap, refresh)).rejects.toThrow("connection lost");
  expect(refresh).not.toHaveBeenCalled();
  fetch.mockResolvedValueOnce(new Response('{"error":"invalid_csrf"}', { status: 403 }));
  await expect(sendMessage(input, bootstrap, refresh)).rejects.toMatchObject({ code: "epoch_changed" });
  expect(fetch).toHaveBeenCalledTimes(2);
});
