import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSupervisor } from "../../src/web/supervisor.js";
import type { WebChannel } from "../../src/channels/web.js";
import type { WebBootstrap } from "../../src/web/protocol.js";
import { API_HEADERS, type Headers } from "./web-http.js";

/**
 * The REAL web process (src/web/child.ts under WebSupervisor) for the suites
 * that test the daemon and the child together. A child takes about half a
 * second to start, so a suite that can should start one per file, not per test.
 */
export interface WebProcess {
  supervisor: WebSupervisor;
  base: string;
  /** Log in with the access token the supervisor wrote; later requests carry the new cookie and CSRF token. */
  bootstrap(): Promise<WebBootstrap>;
  /** The full write gate (Origin, cookie, JSON, CSRF, epoch) for the last bootstrap; `extra` overrides a header, undefined drops it. */
  headers(extra?: Headers): Record<string, string>;
  /** A POST behind the gate; a string body is sent as it is. */
  post(path: string, body: unknown, extra?: Headers): Promise<{ status: number; body: string }>;
  /** Read the SSE stream in the background; `text()` is everything so far. */
  openEvents(): { text: () => string; stop: () => void };
  stop(): Promise<void>;
}

export type WebProcessOptions = ConstructorParameters<typeof WebSupervisor>[1];

/** Start the web process for `channel`, attached and running (port 0: any free one). */
export async function startWebProcess(channel: WebChannel, options: Omit<WebProcessOptions, "port"> & { port?: number },
  supervisorOptions?: ConstructorParameters<typeof WebSupervisor>[2]): Promise<WebProcess> {
  const supervisor = new WebSupervisor(channel, { port: 0, ...options }, supervisorOptions);
  channel.attach(supervisor);
  await channel.start();
  const base = `http://127.0.0.1:${supervisor.status().port}`;
  let cookie = "";
  let boot: WebBootstrap | undefined;
  const headers = (extra: Headers = {}) => Object.fromEntries(Object.entries({
    ...API_HEADERS, cookie, origin: base, "content-type": "application/json", "x-tomo-csrf": boot?.csrfToken, "x-tomo-epoch": boot?.epoch, ...extra,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return {
    supervisor, base, headers,
    async bootstrap() {
      const token = readFileSync(join(options.tomoHome, "web-token"), "utf8").trim();
      const response = await fetch(`${base}/api/v1/bootstrap?t=${token}`, { headers: API_HEADERS });
      if (response.status !== 200) throw new Error(`bootstrap failed: ${response.status}`);
      cookie = response.headers.get("set-cookie")!.split(";")[0];
      boot = await response.json() as WebBootstrap;
      return boot;
    },
    async post(path, body, extra = {}) {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: headers(extra), body: typeof body === "string" ? body : JSON.stringify(body) });
      return { status: response.status, body: await response.text() };
    },
    openEvents() {
      const controller = new AbortController();
      let buffer = "";
      void fetch(`${base}/api/v1/events`, { headers: headers(), signal: controller.signal }).then(async (response) => {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value);
        }
      }).catch(() => {});
      return { text: () => buffer, stop: () => controller.abort() };
    },
    stop: () => supervisor.stop(),
  };
}
