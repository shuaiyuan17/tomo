import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request, type IncomingMessage } from "node:http";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HOME_ASSET_CSP, startWebHttp } from "../src/web/http.js";
import { WebData } from "../src/web/data.js";
import { WebChannel } from "../src/channels/web.js";
import { HomeService } from "../src/home/service.js";
import { WatchBus } from "../src/watch/bus.js";
import { HOME_SNAPSHOT_MAX_BYTES, rpcSchema, type WebBootstrap, type WebEvent, type WebHome } from "../src/web/protocol.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const SVG = Buffer.from('<?xml version="1.0"?>\n<!-- art -->\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
const accessToken = "tomo_web_" + "b".repeat(64);
const base = { "x-tomo-request": "1", "sec-fetch-site": "same-origin" };
const image = { "sec-fetch-site": "same-origin", "sec-fetch-dest": "image" };

let root: string, workspace: string, assets: string;
let service: Awaited<ReturnType<typeof startWebHttp>>;
let channel: WebChannel;
let home: HomeService;
let cookie: string;
let boot: WebBootstrap;
const events: WebEvent[] = [];

async function call(path: string, options: { method?: string; headers?: Record<string, string | undefined>; body?: string | Buffer } = {}) {
  return new Promise<{ status: number; body: Buffer; headers: IncomingMessage["headers"] }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: service.port, path, method: options.method ?? "GET",
      headers: Object.fromEntries(Object.entries({ cookie, ...(options.headers ?? base) }).filter(([, v]) => v !== undefined)) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}
const post = (body: unknown, headers: Record<string, string | undefined> = {}) => call("/api/v1/home/snapshot", { method: "POST",
  headers: { ...base, origin: `http://127.0.0.1:${service.port}`, "content-type": "application/json", "x-tomo-csrf": boot.csrfToken, "x-tomo-epoch": boot.epoch, ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(async () => {
  cookie = "";
  events.length = 0;
  root = mkdtempSync(join(tmpdir(), "tomo-home-web-"));
  workspace = join(root, "workspace");
  assets = join(workspace, "home", "assets");
  mkdirSync(join(workspace, "memory", "private"), { recursive: true });
  const assetsDir = join(root, "web-assets");
  mkdirSync(assetsDir);
  writeFileSync(join(assetsDir, "index.html"), "<!doctype html>");
  const owner = { name: "owner", telegram: ["1"], imessage: [] as string[] };
  home = new HomeService({ workspaceDir: workspace, lastGoodPath: join(root, "data", "last-good.json"), bus: new WatchBus(), pollMs: 60_000 });
  home.start();
  channel = new WebChannel(owner, new WatchBus(), { home: { view: () => home.web(), snapshot: (input) => home.deliverSnapshot(input) } });
  channel.onMessage(async () => true);
  home.attachWeb({ publish: (e) => { events.push(e); channel.events.publish(e); }, available: () => true, mayShowTask: (key) => channel.mayShowTask(key) });
  const sessionsDir = join(root, "sessions"), sdkSessionsDir = join(root, "sdk");
  service = await startWebHttp(0, { accessToken, assetsDir, data: new WebData({ sessionsDir, sdkSessionsDir, owner, workspaceDir: workspace }),
    subscribe: (fn) => channel.events.subscribe(fn),
    rpc: async (input) => {
      // As the supervisor does: the closed schema first.
      const parsed = rpcSchema.parse(input);
      if (parsed.method === "epoch") return channel.events.epoch;
      if (parsed.method === "home") return channel.home();
      if (parsed.method === "home-snapshot") {
        if (parsed.epoch !== channel.events.epoch) throw new Error("epoch");
        return channel.homeSnapshot(parsed.snapshot);
      }
      return { snapshot: channel.snapshot(), replay: null };
    } });
  const response = await call(`/api/v1/bootstrap?t=${accessToken}`);
  expect(response.status).toBe(200);
  boot = JSON.parse(response.body.toString());
  cookie = response.headers["set-cookie"]![0].split(";")[0];
});
afterEach(async () => { await service?.close(); await channel?.stop(); home?.stop(); rmSync(root, { recursive: true, force: true }); });

describe("GET /api/v1/home", () => {
  it("serves WebHome: a valid scene, a revision, the status", async () => {
    const response = await call("/api/v1/home");
    expect(response.status).toBe(200);
    const value = JSON.parse(response.body.toString()) as WebHome;
    expect(value).toMatchObject({ starter: true, revision: expect.stringMatching(/^[a-f0-9]{32}$/), status: { working: false } });
    expect(value.scene.version).toBe(1);
  });
  it("needs the cookie and the API header", async () => {
    expect((await call("/api/v1/home", { headers: { ...base, cookie: undefined } })).status).toBe(401);
    cookie = "";
    expect((await call("/api/v1/home")).status).toBe(401);
  });
  it("refuses a cross-site read", async () => {
    expect((await call("/api/v1/home", { headers: { "x-tomo-request": "1", "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await call("/api/v1/home", { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(403);
  });
});

describe("GET /api/v1/home/assets/<name>", () => {
  it("serves a PNG and an SVG with the right type, no-store, nosniff, and a CSP for the SVG", async () => {
    writeFileSync(join(assets, "art.png"), PNG);
    writeFileSync(join(assets, "logo.svg"), SVG);
    const png = await call("/api/v1/home/assets/art.png", { headers: image });
    expect(png.status).toBe(200);
    expect(png.headers["content-type"]).toBe("image/png");
    expect(png.headers["cache-control"]).toBe("no-store");
    expect(png.headers["x-content-type-options"]).toBe("nosniff");
    expect(png.body.equals(PNG)).toBe(true);
    // The page's cache-busting query is accepted and ignored.
    expect((await call("/api/v1/home/assets/art.png?r=0123456789abcdef", { headers: image })).status).toBe(200);
    const svg = await call("/api/v1/home/assets/logo.svg", { headers: image });
    expect(svg.status).toBe(200);
    expect(svg.headers["content-type"]).toBe("image/svg+xml");
    expect(svg.headers["content-security-policy"]).toBe(HOME_ASSET_CSP);
    expect(HOME_ASSET_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
  });
  it("needs the cookie and a same-origin image fetch", async () => {
    writeFileSync(join(assets, "art.png"), PNG);
    expect((await call("/api/v1/home/assets/art.png", { headers: { ...image, cookie: undefined } })).status).toBe(401);
    expect((await call("/api/v1/home/assets/art.png", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-dest": "image" } })).status).toBe(403);
    expect((await call("/api/v1/home/assets/art.png", { headers: { "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" } })).status).toBe(403);
  });
  it("refuses traversal, symlinks, hard links, private memory, the wrong type and oversize: all the same 404", async () => {
    const secret = join(workspace, "memory", "private", "secret.png");
    writeFileSync(secret, PNG);
    symlinkSync(secret, join(assets, "link.png"));
    linkSync(secret, join(assets, "hard.png"));
    writeFileSync(join(assets, "fake.png"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    writeFileSync(join(assets, "fake.svg"), PNG);
    writeFileSync(join(assets, "big.png"), Buffer.concat([PNG, Buffer.alloc(512 * 1024)]));
    writeFileSync(join(assets, "notes.txt"), "text");
    for (const name of ["link.png", "hard.png", "fake.png", "fake.svg", "big.png", "notes.txt", "missing.png", "..%2Fmemory%2Fprivate%2Fsecret.png",
      "%2e%2e", "..", "Art.PNG", "%00.png", "%E0%A4%A.png"]) {
      const response = await call(`/api/v1/home/assets/${name}`, { headers: image });
      expect([response.status, name]).toEqual([404, name]);
      expect(response.body.includes(PNG.subarray(8, 24))).toBe(false);
    }
    // Not even routed as a picture: refused before any file is looked at.
    expect([403, 404]).toContain((await call("/api/v1/home/assets/../../memory/private/secret.png", { headers: image })).status);
  });
  it("a symlinked assets folder, or home folder, serves nothing", async () => {
    writeFileSync(join(workspace, "memory", "private", "a.png"), PNG);
    rmSync(assets, { recursive: true });
    symlinkSync(join(workspace, "memory", "private"), assets);
    expect((await call("/api/v1/home/assets/a.png", { headers: image })).status).toBe(404);
    rmSync(join(workspace, "home"), { recursive: true });
    mkdirSync(join(root, "elsewhere", "assets"), { recursive: true });
    writeFileSync(join(root, "elsewhere", "assets", "a.png"), PNG);
    symlinkSync(join(root, "elsewhere"), join(workspace, "home"));
    expect((await call("/api/v1/home/assets/a.png", { headers: image })).status).toBe(404);
  });
});

describe("POST /api/v1/home/snapshot", () => {
  const snapshot = (extra: Record<string, unknown> = {}) => ({ revision: "r1", png: PNG.toString("base64"), ...extra });

  it("round trip: home_check's look asks the page, the page answers, the look gets the picture", async () => {
    // The page showing the home has read it.
    expect((await call("/api/v1/home")).status).toBe(200);
    const look = home.look("r1", 3000);
    const ask = events.find((e) => e.type === "home-look") as Extract<WebEvent, { type: "home-look" }>;
    expect(ask).toBeDefined();
    const response = await post(snapshot({ requestId: ask.requestId }));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString())).toEqual({ accepted: true });
    const result = await look;
    expect(result.status).toBe("picture");
    if (result.status === "picture") expect(result.snapshot.png.equals(PNG)).toBe(true);
  });
  it("a picture sent unasked is kept as the latest", async () => {
    expect((await post(snapshot())).status).toBe(200);
    expect(home.latestSnapshot()?.png.equals(PNG)).toBe(true);
  });
  it("needs CSRF, the current epoch, the exact origin and the cookie", async () => {
    expect((await post(snapshot(), { "x-tomo-csrf": "nope" })).status).toBe(403);
    expect((await post(snapshot(), { "x-tomo-epoch": randomUUID() })).status).toBe(409);
    expect((await post(snapshot(), { "x-tomo-epoch": undefined })).status).toBe(409);
    expect((await post(snapshot(), { origin: "http://evil.test" })).status).toBe(403);
    expect((await post(snapshot(), { cookie: undefined })).status).toBe(401);
    expect(home.latestSnapshot()).toBeUndefined();
  });
  it("refuses what is not a PNG, a bad body, and an oversize one (the body limit is raised only to the schema's bound)", async () => {
    expect((await post(snapshot({ png: Buffer.from("GIF89a...........................").toString("base64") }))).status).toBe(400);
    expect((await post(snapshot({ png: "not base64!" }))).status).toBe(400);
    expect((await post(snapshot({ extra: 1 }))).status).toBe(400);
    expect((await post("{ nope")).status).toBe(400);
    // Bigger than MAX_BODY_BYTES but within the schema: accepted.
    const large = Buffer.concat([PNG, Buffer.alloc(300 * 1024)]);
    expect((await post(snapshot({ png: large.toString("base64") }))).status).toBe(200);
    const tooBig = Buffer.concat([PNG, Buffer.alloc(HOME_SNAPSHOT_MAX_BYTES)]);
    expect((await post(snapshot({ png: tooBig.toString("base64") }))).status).toBe(400);
    expect((await post(snapshot({ png: "A".repeat(2 * HOME_SNAPSHOT_MAX_BYTES) }))).status).toBe(413);
    expect(home.latestSnapshot()?.png.length).toBe(large.length);
  });
  it("the daemon re-checks what the web process sends", () => {
    expect(() => home.deliverSnapshot({ revision: "x", png: Buffer.from("not a png at all, really not one").toString("base64") })).toThrow();
    expect(() => home.deliverSnapshot({ revision: "x", png: PNG.toString("base64"), script: 1 })).toThrow();
  });
  it("with no browser, look says so at once", async () => {
    home.attachWeb({ publish: () => {}, available: () => false, mayShowTask: () => false });
    expect(await home.look("r1", 3000)).toEqual({ status: "no_browser" });
  });
});
