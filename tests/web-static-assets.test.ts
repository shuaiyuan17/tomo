import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request, type IncomingMessage } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { WebData } from "../src/web/data.js";
import { CompressedAssets, localizeIndexHtml, pickEncoding } from "../src/web/static-assets.js";
import { startWebService, type WebService } from "./helpers/web-http.js";

/** The packaged page and bundle as the web process serves them (src/web/static-assets.ts). */
let root: string;
let web: WebService;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tomo-web-assets-"));
  mkdirSync(join(root, "assets", "assets"), { recursive: true });
  writeFileSync(join(root, "assets", "index.html"), "<!doctype html><title>Tomo</title>");
  for (const icon of ["favicon.svg", "manifest.webmanifest"]) writeFileSync(join(root, "assets", icon), icon);
  writeFileSync(join(root, "assets", "assets", "app-test.js"), "export {};");
  web = await startWebService({ assetsDir: join(root, "assets"), data: new WebData({ sessionsDir: join(root, "sessions"), sdkSessionsDir: join(root, "sdk") }),
    rpc: async () => ({ snapshot: {}, replay: null }) });
});
afterEach(async () => { await web?.close(); rmSync(root, { recursive: true, force: true }); });

describe("static assets", () => {
  it("caches hashed assets for a year and compresses text once per version; index.html and icons stay no-store", async () => {
    const raw = (path: string, encoding?: string) => new Promise<{ headers: IncomingMessage["headers"]; body: Buffer }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: web.port, path, headers: { ...(encoding ? { "accept-encoding": encoding } : {}) } }, (res) => {
        const parts: Buffer[] = []; res.on("data", (part: Buffer) => parts.push(part));
        res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(parts) }));
      });
      req.on("error", reject); req.end();
    });
    const source = `export const text = ${JSON.stringify("tomo ".repeat(2_000))};`;
    writeFileSync(join(root, "assets", "assets", "big-abc123.js"), source);
    const br = await raw("/assets/big-abc123.js", "gzip, deflate, br");
    expect(br.headers["content-encoding"]).toBe("br");
    expect(br.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(br.headers.vary).toBe("accept-encoding");
    expect(Number(br.headers["content-length"])).toBe(br.body.length);
    expect(br.body.length).toBeLessThan(source.length / 10);
    expect(brotliDecompressSync(br.body).toString()).toBe(source);
    const gz = await raw("/assets/big-abc123.js", "gzip");
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gz.body).toString()).toBe(source);
    const plain = await raw("/assets/big-abc123.js");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.body.toString()).toBe(source);
    // The security headers still go out with a cached asset.
    expect(plain.headers["content-security-policy"]).toContain("script-src 'self'");
    // A rebuilt file under the same name is not served from the stale compressed copy.
    writeFileSync(join(root, "assets", "assets", "big-abc123.js"), source + "\n// rebuilt");
    expect(brotliDecompressSync((await raw("/assets/big-abc123.js", "br")).body).toString()).toBe(source + "\n// rebuilt");
    // Tiny files and already-compressed formats go out as they are.
    expect((await raw("/assets/app-test.js", "br")).headers["content-encoding"]).toBeUndefined();
    for (const path of ["/", "/favicon.svg", "/manifest.webmanifest"]) {
      expect((await raw(path, "br")).headers["cache-control"]).toBe("no-store");
    }
  });
  it("warms the bundle's brotli copies at startup, regular files only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-web-warm-")); mkdirSync(join(dir, "assets"));
    const source = "x".repeat(4_000);
    writeFileSync(join(dir, "assets", "app-1.js"), source); writeFileSync(join(dir, "index.html"), source);
    writeFileSync(join(dir, "elsewhere.js"), source); symlinkSync(join(dir, "elsewhere.js"), join(dir, "assets", "link-1.js"));
    const cache = new CompressedAssets();
    await cache.warm(dir);
    const version = (path: string) => { const stat = statSync(join(dir, path)); return `${stat.size}:${stat.mtimeMs}`; };
    // Already compressed: the bytes passed now are not what is returned.
    for (const path of ["assets/app-1.js", "index.html"]) {
      expect(brotliDecompressSync(await cache.get(path, version(path), "br", Buffer.from("other"))).toString()).toBe(source);
    }
    expect(brotliDecompressSync(await cache.get("assets/link-1.js", version("assets/link-1.js"), "br", Buffer.from("other"))).toString()).toBe("other");
    await cache.warm(join(dir, "missing"));
    rmSync(dir, { recursive: true, force: true });
  });
  it("negotiates brotli, then gzip, honouring q=0", () => {
    expect(pickEncoding("gzip, deflate, br, zstd")).toBe("br");
    expect(pickEncoding("gzip;q=1.0, br;q=0")).toBe("gzip");
    expect(pickEncoding("GZIP")).toBe("gzip");
    expect(pickEncoding("br ;q=1")).toBe("br");
    expect(pickEncoding("gzip, br ;q=0")).toBe("gzip");
    expect(pickEncoding("*")).toBe("br");
    expect(pickEncoding("*;q=0, gzip")).toBe("gzip");
    expect(pickEncoding("identity")).toBeUndefined();
    expect(pickEncoding("br;q=0, gzip;q=0")).toBeUndefined();
    expect(pickEncoding(undefined)).toBeUndefined();
    expect(pickEncoding("")).toBeUndefined();
  });
  it("leaves the page as built for an unset or malformed locale", () => {
    const html = Buffer.from('<html lang="en"><body></body></html>');
    expect(localizeIndexHtml(html, undefined)).toBe(html);
    expect(localizeIndexHtml(html, '"><script>')).toBe(html);
  });
});
