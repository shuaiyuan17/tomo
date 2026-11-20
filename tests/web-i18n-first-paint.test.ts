import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebHttp } from "../src/web/http.js";
import { WebData } from "../src/web/data.js";
import { localizeIndexHtml } from "../src/web/static-assets.js";

/**
 * config `locale` reaches the page before any script runs (on `<html>`), so
 * the first paint is already in that language: no English flash while
 * bootstrap is in flight.
 */
const accessToken = "tomo_web_" + "b".repeat(64);
let root = "";
let service: Awaited<ReturnType<typeof startWebHttp>> | undefined;
afterEach(async () => { vi.unstubAllGlobals(); vi.resetModules(); await service?.close(); service = undefined; if (root) rmSync(root, { recursive: true, force: true }); });

async function servedPage(locale?: "en" | "zh-Hans"): Promise<string> {
  await service?.close(); service = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), "tomo-web-first-paint-"));
  const assetsDir = join(root, "assets"); mkdirSync(join(assetsDir, "assets"), { recursive: true });
  writeFileSync(join(assetsDir, "index.html"), '<!doctype html>\n<html lang="en">\n<head><title>Tomo</title></head><body><div id="root"></div></body></html>');
  const owner = { name: "owner", telegram: ["test-owner"], imessage: [] as string[] };
  service = await startWebHttp(0, { accessToken, externalOrigin: "https://test-node.test-tailnet.ts.net", now: () => Date.now(), assetsDir,
    data: new WebData({ sessionsDir: join(root, "sessions"), sdkSessionsDir: join(root, "sdk"), owner, locale }),
    subscribe: () => () => {}, rpc: async () => { throw new Error("unused"); } });
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: service!.port, path: "/", headers: { "sec-fetch-site": "same-origin" } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (part) => { text += part; }); res.on("end", () => resolve(text));
    });
    req.on("error", reject); req.end();
  });
}

/** Loads the web i18n module afresh, as the browser does on page load, against `<html>` as served. */
async function initialLanguage(html: string, browser: string, stored: string | null = null): Promise<string> {
  const attribute = /data-tomo-locale="([^"]+)"/.exec(html)?.[1];
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { language: browser, languages: [browser] });
  vi.stubGlobal("localStorage", { getItem: () => stored, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal("document", { documentElement: { dataset: attribute ? { tomoLocale: attribute } : {}, lang: "" } });
  vi.resetModules();
  const { i18n } = await import("../web/src/i18n/index.js");
  return i18n.language;
}

describe("the first paint's language", () => {
  it("is config locale when nothing is stored, even in an English browser", async () => {
    const html = await servedPage("zh-Hans");
    expect(html).toContain('<html lang="zh-Hans" data-tomo-locale="zh-Hans">');
    expect(await initialLanguage(html, "en-US")).toBe("zh-Hans");
  });

  it("still yields to this browser's own pick, and without config to the browser's language", async () => {
    expect(await initialLanguage(await servedPage("zh-Hans"), "en-US", "en")).toBe("en");
    const plain = await servedPage();
    expect(plain).not.toContain("data-tomo-locale");
    expect(await initialLanguage(plain, "zh-CN")).toBe("zh-Hans");
    expect(await initialLanguage(plain, "en-GB")).toBe("en");
  });

  it("leaves the page as built for an unset or malformed locale", () => {
    const html = Buffer.from('<html lang="en"><body></body></html>');
    expect(localizeIndexHtml(html, undefined)).toBe(html);
    expect(localizeIndexHtml(html, '"><script>')).toBe(html);
  });
});

describe("bootstrap and the served locale", () => {
  /** The page as served with config zh-Hans, in an English browser with nothing stored, then `bootstrap` (or none). */
  async function after(bootstrap: { locale?: string } | null | undefined): Promise<{ update: unknown; language: string }> {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { language: "en-US", languages: ["en-US"] });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal("document", { documentElement: { dataset: { tomoLocale: "zh-Hans" }, lang: "" } });
    vi.resetModules();
    const { i18n, applyConfiguredLocale, configuredLocaleUpdate } = await import("../web/src/i18n/index.js");
    // What main.tsx does on every render's effect.
    const update = configuredLocaleUpdate(bootstrap);
    if (update !== "keep") applyConfiguredLocale(update.locale);
    return { update, language: i18n.language };
  }

  it("keeps the served locale until a bootstrap has arrived (connecting, locked, failed)", async () => {
    expect(await after(undefined)).toEqual({ update: "keep", language: "zh-Hans" });
    expect(await after(null)).toEqual({ update: "keep", language: "zh-Hans" });
  });

  it("follows an arrived bootstrap: its locale, or the browser's language when it has none", async () => {
    expect(await after({ locale: "zh-Hans" })).toEqual({ update: { locale: "zh-Hans" }, language: "zh-Hans" });
    expect(await after({})).toEqual({ update: { locale: undefined }, language: "en" });
  });
});
