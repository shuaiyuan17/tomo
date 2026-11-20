import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * errorDetail: our own failures are translated by kind (their English
 * `.message` unchanged, for logs and the model); anything else is passed
 * through as its own words.
 */
const live = { config: { locale: null as "en" | "zh-Hans" | null } };
vi.mock("../src/config.js", () => ({ config: live.config }));
vi.mock("../src/logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { errorDetail } = await import("../src/i18n/error-detail.js");
const { FileLockTimeoutError } = await import("../src/file-lock.js");
const { TodoStoreConflictError, TodoStoreReadError } = await import("../src/todos/store.js");
const { RewindError, SessionHistoryChangedError } = await import("../src/agent/session-rewind.js");
const { ClaudeLoginError } = await import("../src/agent/claude-login.js");
const { McpLoginError } = await import("../src/mcp/oauth.js");

afterEach(() => { live.config.locale = null; });

const ours = () => [
  new FileLockTimeoutError("/x/todos.lock", 5000, 42),
  new TodoStoreReadError("/x/todos.json", new Error("Unexpected token n")),
  new TodoStoreConflictError("/x/todos.json"),
  new RewindError({ kind: "too_few", count: 2 }),
  new SessionHistoryChangedError("writing"),
  new ClaudeLoginError({ kind: "exited", code: 1 }),
  new ClaudeLoginError({ kind: "verification_failed", detail: "Invalid API key" }),
  new McpLoginError("unknown_server", "github"),
];

describe("errorDetail", () => {
  it("with locale unset, is exactly each error's English message", () => {
    for (const err of ours()) expect(errorDetail(err)).toBe(err.message);
  });

  it("under zh-Hans, translates our fixed text and keeps paths and outside detail as they are", () => {
    live.config.locale = "zh-Hans";
    expect(ours().map((err) => errorDetail(err))).toEqual([
      "5000 毫秒内没能拿到锁 /x/todos.lock（被进程 42 占用）",
      "无法读取待办存储：/x/todos.json（Unexpected token n）。没有做任何改动，请修复或恢复这个文件。",
      "待办存储在写入时被改动了：/x/todos.json。没有覆盖任何内容，请再试一次。",
      "当前上下文里只有 2 条记录的用户消息可以回退。更早或已压缩的消息可能无法回退；/new 可以重新开始。",
      "session 记录还在写入中，请稍后再试 /rewind。",
      "Claude 登录没有完成（退出码 1）",
      "Claude 登录验证失败：Invalid API key",
      "没有名为“github”的外部 MCP 服务器",
    ]);
  });

  it("passes an outside error through as written", () => {
    live.config.locale = "zh-Hans";
    expect(errorDetail(Object.assign(new Error("EACCES: permission denied, open '/x'"), { code: "EACCES" }))).toBe("EACCES: permission denied, open '/x'");
  });
});
