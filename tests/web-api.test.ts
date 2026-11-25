import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ApiError, decidePermission, mutate, sendMessage, stream, submitCredential } from "../web/src/api.js";
import type { WebBootstrap } from "../src/web/protocol.js";

/**
 * The page's API client (web/src/api.ts) against a stubbed fetch: which
 * route and headers each write uses, and when it retries. The server's side
 * of the same gate is web-http.test.ts.
 */
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const bootstrap = { csrfToken: "old", epoch: "e0e0e0e0-0000-4000-8000-000000000000" } as WebBootstrap;
/** fetch answers `responses` in order (the last one repeats); a thrown Error is a network failure. */
function stubFetch(...responses: Array<{ status: number; body: unknown } | Error>) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = responses.length > 1 ? responses.shift()! : responses[0];
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const sent = (fetch: ReturnType<typeof stubFetch>, call = 0) => {
  const [url, init] = fetch.mock.calls[call] as [string, RequestInit];
  return { url, method: init.method, body: init.body, headers: init.headers as Record<string, string> };
};

describe("sendMessage", () => {
  const input = { requestId: randomUUID(), text: "test" };
  it.each([[403, "invalid_csrf"], [403, "invalid_origin"], [503, "service_unavailable"]])("limits retry for %s %s", async (status, code) => {
    const fetch = stubFetch({ status, body: { error: code } });
    const refresh = vi.fn(async () => ({ ...bootstrap, csrfToken: "new" }));
    await expect(sendMessage(input, bootstrap, refresh)).rejects.toMatchObject({ status, code });
    expect(fetch).toHaveBeenCalledTimes(code === "invalid_csrf" ? 2 : 1);
    expect(refresh).toHaveBeenCalledTimes(code === "invalid_csrf" ? 1 : 0);
  });
  it("does not retry a network failure or silently switch daemon epochs", async () => {
    const fetch = stubFetch(new Error("connection lost"), { status: 403, body: { error: "invalid_csrf" } });
    const refresh = vi.fn(async () => ({ ...bootstrap, epoch: "new-epoch" }));
    await expect(sendMessage(input, bootstrap, refresh)).rejects.toThrow("connection lost");
    expect(refresh).not.toHaveBeenCalled();
    await expect(sendMessage(input, bootstrap, refresh)).rejects.toMatchObject({ code: "epoch_changed" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("mutate (the Study's writes)", () => {
  it("retries only a definite CSRF rejection, once, under the same epoch", async () => {
    let fetch = stubFetch({ status: 403, body: { error: "invalid_csrf" } }, { status: 200, body: { ok: true } });
    expect(await mutate("/cron/x", "DELETE", {}, bootstrap, async () => ({ ...bootstrap, csrfToken: "new" }))).toEqual({ ok: true });
    expect([sent(fetch, 0), sent(fetch, 1)].map((call) => [call.method, call.headers["x-tomo-csrf"]])).toEqual([["DELETE", "old"], ["DELETE", "new"]]);
    fetch = stubFetch({ status: 403, body: { error: "invalid_csrf" } }, { status: 200, body: { ok: true } });
    await expect(mutate("/cron/x", "DELETE", {}, bootstrap, async () => ({ ...bootstrap, epoch: "e2", csrfToken: "new" }))).rejects.toEqual(new ApiError(409, "epoch_changed"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("card answers go to their own routes, never /messages, with CSRF and the epoch", () => {
  const id = "4f1c2a9e-0000-4000-8000-000000000001";
  it("submitCredential", async () => {
    const fetch = stubFetch({ status: 200, body: { status: "stored" } });
    await expect(submitCredential(id, { value: "fake-card-value" }, bootstrap, async () => bootstrap)).resolves.toEqual({ status: "stored" });
    expect(sent(fetch)).toMatchObject({ url: `/api/v1/credentials/${id}`, method: "POST", headers: { "x-tomo-csrf": "old", "x-tomo-epoch": bootstrap.epoch } });
  });
  it("decidePermission", async () => {
    const fetch = stubFetch({ status: 200, body: { status: "allowed_once" } });
    await expect(decidePermission(id, "once", bootstrap, async () => bootstrap)).resolves.toEqual({ status: "allowed_once" });
    expect(sent(fetch)).toMatchObject({ url: `/api/v1/permissions/${id}`, method: "POST", body: JSON.stringify({ decision: "once" }),
      headers: { "x-tomo-csrf": "old", "x-tomo-epoch": bootstrap.epoch } });
  });
});

describe("stream", () => {
  it("gives up a connection that goes quiet (no heartbeat) instead of waiting forever", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(": heartbeat\n\n")); } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    const done = stream("c", new AbortController().signal, { snapshot: () => {}, update: () => {}, cursor: () => {} }, 1_000);
    const outcome = expect(done).rejects.toThrow("Stream went quiet");
    await vi.advanceTimersByTimeAsync(1_500);
    await outcome;
  });
});
