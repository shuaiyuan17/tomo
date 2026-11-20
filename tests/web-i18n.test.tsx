import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WebBootstrap, WebPermissionRequest } from "../src/web/protocol.js";
import { formatLocaleFor, i18n, pickLocale, setLocaleChoice, storedLocale } from "../web/src/i18n/index.js";
import { formatCompact, formatDate, formatRelative } from "../web/src/i18n/format.js";
import { PermissionCard } from "../web/src/permission-card.js";
import { updatedAgo } from "../web/src/screen-stream.js";
import { formatTokens } from "../web/src/study-data.js";
import { reviewLabel } from "../web/src/todos.js";

afterEach(async () => { await i18n.changeLanguage("en"); vi.unstubAllGlobals(); });

describe("the web UI's language", () => {
  it("is the Settings choice, else config locale, else the browser's language, else English", () => {
    expect(pickLocale("en", "zh-Hans", ["zh-CN"])).toBe("en");
    expect(pickLocale(null, "zh-Hans", ["en-US"])).toBe("zh-Hans");
    expect(pickLocale(null, undefined, ["fr-FR", "zh-CN", "en-US"])).toBe("zh-Hans");
    expect(pickLocale(null, undefined, ["zh-TW"])).toBe("en");
    expect(pickLocale(null, undefined, [])).toBe("en");
  });

  it("remembers the Settings choice per browser, and forgets it on Default", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    setLocaleChoice("zh-Hans");
    expect(storedLocale()).toBe("zh-Hans");
    expect(i18n.language).toBe("zh-Hans");
    setLocaleChoice(null);
    expect(storedLocale()).toBeNull();
    expect(i18n.language).toBe("en");
  });

  it("renders the permission card in Chinese under zh-Hans (and English by default)", async () => {
    const request: WebPermissionRequest = { id: "7a1c2a9e-0000-4000-8000-000000000001", code: "K7Q", group: "Weekend project", path: "/srv/app",
      access: "write", reason: "run the tests", expiresAt: Date.now() + 120_000 };
    const props = { request, bootstrap: { csrfToken: "x" } as unknown as WebBootstrap, refresh: async () => ({}) as WebBootstrap };
    expect(renderToStaticMarkup(createElement(PermissionCard, props))).toContain("Allow once");
    await i18n.changeLanguage("zh-Hans");
    const html = renderToStaticMarkup(createElement(PermissionCard, props));
    for (const text of ["允许一次", "始终允许", "拒绝", "读写", "未验证"]) expect(html).toContain(text);
    expect(html).not.toContain("Allow once");
  });
});

describe("numbers and dates go through Intl in the active locale", () => {
  it("formats in the browser's region when it speaks the UI language, else in the UI locale", () => {
    expect(formatLocaleFor("en", "en-GB")).toBe("en-GB");
    expect(formatLocaleFor("zh-Hans", "zh-CN")).toBe("zh-CN");
    expect(formatLocaleFor("zh-Hans", "en-US")).toBe("zh-Hans");
    expect(formatLocaleFor("en", "zh-CN")).toBe("en");
    expect(formatLocaleFor("en", undefined)).toBe("en");
  });

  it("an en-GB browser with the UI in English gets en-GB dates, not en-US", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { language: "en-GB", languages: ["en-GB"] });
    const date = Date.UTC(2026, 10, 19, 12);
    expect(formatDate(date, { day: "numeric", month: "numeric", year: "numeric", timeZone: "UTC" })).toBe("19/11/2026");
  });

  it("abbreviates token counts with compact notation", async () => {
    expect(formatTokens(12_345)).toBe("12.3K");
    expect(formatCompact(1_234_567)).toBe("1.2M");
    await i18n.changeLanguage("zh-Hans");
    expect(formatTokens(12_345)).toBe("1.2万");
  });

  it("words relative times with RelativeTimeFormat", async () => {
    expect(formatRelative(-7_000, "narrow")).toBe("7s ago");
    expect(updatedAgo(10_000, 17_000)).toBe("Updated 7s ago");
    const now = new Date(2026, 10, 19, 12).getTime();
    expect(reviewLabel(now - 3 * 86_400_000, now)).toBe("Due 3 days ago");
    await i18n.changeLanguage("zh-Hans");
    expect(formatRelative(-7_000, "narrow")).toBe("7秒前");
    expect(updatedAgo(10_000, 17_000)).toBe("7秒前更新");
    expect(reviewLabel(now - 3 * 86_400_000, now)).toBe("3天前到期");
    expect(reviewLabel(now + 86_400_000, now)).toBe("明天回顾");
  });
});

describe("the Plan usage card words the daemon's windows itself", () => {
  it("names a scoped window by its scope, from the kind and model the daemon sends", async () => {
    const { windowTitle } = await import("../web/src/usage.js");
    const base = { id: "x", group: "weekly" as const, percent: 10, resetsAt: null, active: false, elevated: false };
    expect(windowTitle({ ...base, scoped: true, kind: "weekly_scoped", model: "Opus", label: "Weekly · Opus" })).toBe("Opus");
    expect(windowTitle({ ...base, group: "session", scoped: true, kind: "session", model: "Opus", label: "Session (5h) · Opus" })).toBe("5-hour · Opus");
    await i18n.changeLanguage("zh-Hans");
    expect(windowTitle({ ...base, group: "session", scoped: false, label: "Session (5h)" })).toBe("5 小时");
    expect(windowTitle({ ...base, group: "session", scoped: true, kind: "session", model: "Opus", label: "Session (5h) · Opus" })).toBe("5 小时 · Opus");
  });
});

describe("copy kept in state follows a language switch", () => {
  it("a refused send's note is stored as a message and worded when shown", async () => {
    const { ApiError } = await import("../web/src/api.js");
    const { sendFailure, reactFailure } = await import("../web/src/composer.js");
    const { composerStatus } = await import("../web/src/composer-status.js");
    const { deferred } = await import("../web/src/i18n/message.js");
    // What the composer puts in state when a send is refused (nothing translated yet).
    const failure = sendFailure(new ApiError(413, "too_large"), deferred.t("chat:request.unknown", { agent: "Tomo" }));
    const note = { text: failure.text, at: "" };
    const line = () => composerStatus({ activity: undefined, note, latest: undefined, settled: null });
    expect(line()).toContain("Message is too large");
    await i18n.changeLanguage("zh-Hans");
    expect(line()).toBe("消息太长了。缩短后再发，草稿已保留。");
    expect(JSON.stringify(reactFailure(new ApiError(409, "epoch_changed")))).not.toMatch(/[一-鿿]/);
  });

  it("a failed upload and a refused card answer keep codes, worded at render", async () => {
    const { say, deferred } = await import("../web/src/i18n/message.js");
    const { permissionError } = await import("../web/src/permission-card.js");
    const { modelErrorText } = await import("../web/src/model-picker.js");
    const stored = { code: "permission_closed", upload: deferred.t("chat:attach.error.tooLarge") };
    expect([permissionError(stored.code), say(stored.upload), modelErrorText("turn_in_flight", "Tomo")].join(" ")).not.toMatch(/[一-鿿]/);
    await i18n.changeLanguage("zh-Hans");
    expect(permissionError(stored.code)).toBe("这个请求已经结束：已回复或已过期。");
    expect(say(stored.upload)).toContain("太大了");
    expect(modelErrorText("turn_in_flight", "Tomo")).toContain("Tomo 正在回复中");
  });

  it("no component puts translated text into state", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const offenders: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== "i18n") walk(path); continue; }
      if (!/\.tsx?$/.test(name)) continue;
      readFileSync(path, "utf8").split("\n").forEach((line, i) => {
        // A state setter fed translated words: `setX(t(...))`, `setX(i18n.t(...))`, `setX(someError(code))`.
        // (reactFailure / sendFailure return a Message, not words.)
        if (/\bset[A-Z]\w*\(\s*(i18n\.t|t|say|(?!reactFailure|sendFailure)[a-z]\w*(Error|Failure|Text|Label|Notice))\(/.test(line)) offenders.push(`${path}:${i + 1}`);
      });
    } };
    walk("web/src");
    expect(offenders).toEqual([]);
  });
});

describe("a custom emoji tapback follows a language switch", () => {
  it("parses once (cached) and words its verb when rendered", async () => {
    const { formatReactionMarker } = await import("../src/channels/text-utils.js");
    const { parseHistory } = await import("../web/src/conversation-rows.js");
    const { TapbackLine } = await import("../web/src/components/ai/message-actions.js");
    const history = [{ id: "m1", role: "user" as const, content: formatReactionMarker("🔥", "hi"), timestamp: 1 }];
    const line = () => {
      const tapback = parseHistory(history as never)[0]!.parsed.tapback!;
      return renderToStaticMarkup(createElement(TapbackLine, { who: "You", reaction: tapback.reaction, quote: tapback.reply?.excerpt }));
    };
    expect(line()).toContain("reacted to");
    await i18n.changeLanguage("zh-Hans");
    // The same message object: the parse is served from the cache, the verb is not.
    expect(line()).toContain("回应了");
    expect(line()).not.toContain("reacted to");
  });
});
