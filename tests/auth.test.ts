import { describe, expect, it } from "vitest";
import { anthropicAuthLabel, parseAnthropicAuthConfig } from "../src/auth.js";

describe("Anthropic auth config", () => {
  it("defaults to Claude subscription auth", () => {
    expect(parseAnthropicAuthConfig(undefined, {})).toEqual({
      method: "subscription",
      apiKey: null,
      apiKeySource: null,
      error: null,
    });
  });

  it("uses a configured API key", () => {
    expect(parseAnthropicAuthConfig({ method: "api-key", apiKey: " sk-config " }, {})).toEqual({
      method: "api-key",
      apiKey: "sk-config",
      apiKeySource: "config",
      error: null,
    });
  });

  it("infers API-key auth when a stored key has no explicit method", () => {
    expect(parseAnthropicAuthConfig({ apiKey: "sk-config" }, {}).method).toBe("api-key");
  });

  it("lets ANTHROPIC_API_KEY override file configuration", () => {
    expect(parseAnthropicAuthConfig(
      { method: "subscription" },
      { ANTHROPIC_API_KEY: " sk-env " },
    )).toEqual({
      method: "api-key",
      apiKey: "sk-env",
      apiKeySource: "environment",
      error: null,
    });
  });

  it("reports a selected API-key method with no key", () => {
    const auth = parseAnthropicAuthConfig({ method: "api-key" }, {});
    expect(auth.error).toContain("no API key is configured");
  });

  it("reports invalid methods without throwing during config import", () => {
    const auth = parseAnthropicAuthConfig({ method: "magic" }, {});
    expect(auth.method).toBe("subscription");
    expect(auth.error).toContain("Invalid Anthropic auth method");
  });

  it("provides user-facing method labels", () => {
    expect(anthropicAuthLabel("subscription")).toBe("Claude subscription");
    expect(anthropicAuthLabel("api-key")).toBe("Anthropic API key");
  });
});
