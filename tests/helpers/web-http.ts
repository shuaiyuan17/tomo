import { request, type IncomingMessage } from "node:http";
import { startWebHttp, type HttpDependencies } from "../../src/web/http.js";
import type { WebChannel } from "../../src/channels/web.js";
import type { WebBootstrap } from "../../src/web/protocol.js";

/**
 * The in-process web HTTP service as a browser tab sees it: started on a free
 * loopback port, already bootstrapped (cookie and CSRF token in hand), with
 * request helpers that send the headers every private API needs.
 *
 * Requests go through `node:http`, not `fetch`, because the gate tests must be
 * able to send a forged `Host` and to leave a header out entirely: a header
 * passed as `undefined` is not sent.
 */
export const WEB_TEST_TOKEN = "tomo_web_" + "a".repeat(64);
/** What the page's `api()` sends on every private request. */
export const API_HEADERS = { "x-tomo-request": "1", "sec-fetch-site": "same-origin" } as const;

export type Headers = Record<string, string | undefined>;
export interface WebResponse { status: number; text: string; headers: IncomingMessage["headers"]; json<T = Record<string, unknown>>(): T }

export interface WebService {
  service: Awaited<ReturnType<typeof startWebHttp>>;
  port: number;
  /** `http://127.0.0.1:<port>`: the exact Origin a mutation must carry. */
  base: string;
  boot: WebBootstrap;
  cookie: string;
  /** Any request, with the API headers and the session cookie unless `headers` overrides them. */
  call(path: string, options?: { method?: string; headers?: Headers; body?: string | Buffer }): Promise<WebResponse>;
  get(path: string, headers?: Headers): Promise<WebResponse>;
  /** Origin, cookie, JSON, the CSRF token and the epoch: the gate every write passes. */
  mutationHeaders(): Record<string, string>;
  /** A JSON mutation behind the full gate; `headers` overrides one part of it. */
  send(method: string, path: string, body: unknown, headers?: Headers): Promise<WebResponse>;
  /** Read an SSE stream until `until(text)` holds (or `timeoutMs` passes), then close it; returns what was read. */
  readSse(path: string, until: (text: string) => boolean, options?: { timeoutMs?: number; headers?: Headers }): Promise<string>;
  close(): Promise<void>;
}

/** Start `startWebHttp` and log in once with the access token. */
export async function startWebService(deps: Omit<HttpDependencies, "accessToken" | "subscribe" | "rpc"> & Partial<Pick<HttpDependencies, "accessToken" | "subscribe" | "rpc">>): Promise<WebService> {
  const accessToken = deps.accessToken ?? WEB_TEST_TOKEN;
  const service = await startWebHttp(0, { subscribe: () => () => {}, rpc: async () => { throw new Error("unexpected rpc"); }, ...deps, accessToken });
  const base = `http://127.0.0.1:${service.port}`;
  let cookie = "";
  const call: WebService["call"] = (path, options = {}) => new Promise((resolve, reject) => {
    // An explicit length: node sends a DELETE body unframed otherwise.
    const length = options.body === undefined ? {} : { "content-length": String(Buffer.byteLength(options.body)) };
    const headers = Object.fromEntries(Object.entries({ ...API_HEADERS, cookie, ...length, ...options.headers })
      .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ""));
    const req = request({ host: "127.0.0.1", port: service.port, path, method: options.method ?? "GET", headers }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (part) => { text += part; });
      res.on("end", () => resolve({ status: res.statusCode!, text, headers: res.headers, json: () => JSON.parse(text) }));
    });
    req.on("error", reject); req.end(options.body);
  });
  const login = await call(`/api/v1/bootstrap?t=${accessToken}`);
  if (login.status !== 200) { await service.close(); throw new Error(`bootstrap failed: ${login.status} ${login.text}`); }
  cookie = login.headers["set-cookie"]![0].split(";")[0];
  const boot = login.json<WebBootstrap>();
  const mutationHeaders = () => ({ origin: base, cookie, "content-type": "application/json", "x-tomo-csrf": boot.csrfToken, "x-tomo-epoch": boot.epoch });
  return {
    service, port: service.port, base, boot,
    get cookie() { return cookie; },
    call,
    get: (path, headers) => call(path, { headers }),
    mutationHeaders,
    send: (method, path, body, headers = {}) => call(path, { method, headers: { ...mutationHeaders(), ...headers }, body: JSON.stringify(body) }),
    readSse: async (path, until, options = {}) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000);
      let text = "";
      try {
        const response = await fetch(base + path, { headers: Object.fromEntries(Object.entries({ ...API_HEADERS, cookie, ...options.headers })
          .filter((entry): entry is [string, string] => entry[1] !== undefined)), signal: controller.signal });
        const reader = response.body!.getReader();
        try {
          while (!until(text)) {
            const part = await reader.read().catch(() => ({ done: true as const, value: undefined }));
            if (part.done) break;
            text += new TextDecoder().decode(part.value);
          }
        } finally { await reader.cancel().catch(() => {}); }
      } finally { clearTimeout(timeout); controller.abort(); }
      return text;
    },
    close: () => service.close(),
  };
}

/**
 * The daemon side of the RPC for a test: the snapshot and epoch come from
 * `channel`, every other method from `handlers` by name; anything else is a
 * test bug and throws.
 */
export function channelRpc(channel: WebChannel, handlers: Record<string, (input: never) => unknown> = {}): HttpDependencies["rpc"] {
  return async (input) => {
    const handler = handlers[input.method];
    if (handler) return handler(input as never);
    if (input.method === "snapshot") return { snapshot: channel.snapshot(), replay: null };
    if (input.method === "epoch") return channel.events.epoch;
    throw new Error(`unexpected rpc: ${input.method}`);
  };
}
