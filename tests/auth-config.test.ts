import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  select: vi.fn(),
  password: vi.fn(),
  saveConfig: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  select: mocks.select,
  password: mocks.password,
  isCancel: () => false,
  log: {
    info: mocks.info,
    success: mocks.success,
    warn: mocks.warn,
  },
}));

vi.mock("../src/cli/config/shared.js", () => ({
  loadConfig: () => mocks.cfg,
  saveConfig: mocks.saveConfig,
}));

const { configAnthropicAuth } = await import("../src/cli/config/auth.js");

describe("tomo config Anthropic auth", () => {
  beforeEach(() => {
    mocks.cfg = {};
    mocks.select.mockReset();
    mocks.password.mockReset();
    mocks.saveConfig.mockReset();
    mocks.info.mockReset();
    mocks.success.mockReset();
    mocks.warn.mockReset();
    vi.unstubAllEnvs();
  });

  it("stores API-key authentication", async () => {
    mocks.select.mockResolvedValue("api-key");
    mocks.password.mockResolvedValue("sk-ant-test");

    await configAnthropicAuth();

    expect(mocks.cfg.auth).toEqual({ method: "api-key", apiKey: "sk-ant-test" });
    expect(mocks.saveConfig).toHaveBeenCalledWith(mocks.cfg);
  });

  it("keeps an existing key when the password prompt is blank", async () => {
    mocks.cfg = { auth: { method: "api-key", apiKey: "sk-existing" } };
    mocks.select.mockResolvedValue("api-key");
    mocks.password.mockResolvedValue("");

    await configAnthropicAuth();

    expect(mocks.cfg.auth).toEqual({ method: "api-key", apiKey: "sk-existing" });
  });

  it("removes the stored key when switching to subscription auth", async () => {
    mocks.cfg = { auth: { method: "api-key", apiKey: "sk-existing" } };
    mocks.select.mockResolvedValue("subscription");

    await configAnthropicAuth();

    expect(mocks.cfg.auth).toEqual({ method: "subscription" });
    expect(mocks.saveConfig).toHaveBeenCalledWith(mocks.cfg);
  });

  it("warns when ANTHROPIC_API_KEY overrides the subscription selection", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    mocks.select.mockResolvedValue("subscription");

    await configAnthropicAuth();

    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("overrides config.json"));
  });
});
