import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Dates and numbers with config `locale` unset must be formatted exactly as
 * before there was a setting: `Intl` is handed `undefined` (the system's
 * own default, whatever it is, en-GB or de-DE), never an explicit "en".
 * Only a configured locale is passed through. The process default cannot
 * be changed from inside a test, so the locale argument each formatter
 * receives is what is checked.
 */
const live = { config: { locale: null as "en" | "zh-Hans" | null } };
vi.mock("../src/config.js", () => ({ config: live.config }));
vi.mock("../src/logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { formatDateTime, formatLocale, formatNumber } = await import("../src/i18n/index.js");
const { formatReset } = await import("../src/agent/usage.js");
const { formatTaskList } = await import("../src/agent/tasks-command.js");

const AT = Date.UTC(2026, 10, 19, 15, 4, 0);

/** The first argument (the locale) of every call to `method`. */
function localesPassedTo<T extends object>(target: T, method: keyof T, run: () => void): unknown[] {
  const spy = vi.spyOn(target, method as never);
  try { run(); return spy.mock.calls.map((call) => (call as unknown[])[0]); } finally { spy.mockRestore(); }
}

afterEach(() => { live.config.locale = null; });

describe("Intl locale when config locale is unset", () => {
  it("is undefined, the system default, not an explicit English", () => {
    expect(formatLocale()).toBeUndefined();
    expect(localesPassedTo(Date.prototype, "toLocaleString", () => formatDateTime(AT))).toEqual([undefined]);
    expect(formatDateTime(AT)).toBe(new Date(AT).toLocaleString());
    expect(formatNumber(1234567)).toBe((1234567).toLocaleString());
  });

  it("reaches the /usage reset clock and the /tasks clock unchanged from before", () => {
    const resetsAt = new Date(AT + 3 * 86_400_000).toISOString();
    expect(localesPassedTo(Date.prototype, "toLocaleTimeString", () => formatReset(resetsAt, AT, formatLocale()))).toEqual([undefined]);
    expect(formatReset(resetsAt, AT, formatLocale()).countdown).toBe("3d 0h");
    // /tasks has always written a 24-hour en-US clock.
    const list = { running: [], ended: [{ taskId: "t", taskType: "local_bash", description: "build", state: "completed", startedAt: AT - 60_000, endedAt: AT } as never] };
    expect(localesPassedTo(Date.prototype, "toLocaleTimeString", () => formatTaskList(list, { now: AT, locale: formatLocale() }))).toEqual(["en-US"]);
  });
});

describe("Intl locale when config locale is zh-Hans", () => {
  it("is passed through, and the output is Chinese", () => {
    live.config.locale = "zh-Hans";
    expect(formatLocale()).toBe("zh-Hans");
    expect(formatDateTime(AT)).toBe(new Date(AT).toLocaleString("zh-Hans"));
    const resetsAt = new Date(AT + 3 * 86_400_000).toISOString();
    const reset = formatReset(resetsAt, AT, formatLocale());
    expect(reset.countdown).toBe("3 天 0 小时");
    expect(reset.clock).toMatch(/月/);
    const list = { running: [], ended: [{ taskId: "t", taskType: "local_bash", description: "build", state: "completed", startedAt: AT - 60_000, endedAt: AT } as never] };
    expect(localesPassedTo(Date.prototype, "toLocaleTimeString", () => formatTaskList(list, { now: AT, locale: formatLocale() }))).toEqual(["zh-Hans"]);
    expect(formatTaskList(list, { now: AT, locale: formatLocale() })).toMatch(/^任务 · 今天 0 个运行中，1 个已完成\n✓ build · bash · 1 分钟 · /);
  });
});
