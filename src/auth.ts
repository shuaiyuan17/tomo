export const ANTHROPIC_AUTH_METHODS = ["subscription", "api-key"] as const;

export type AnthropicAuthMethod = typeof ANTHROPIC_AUTH_METHODS[number];
export type AnthropicApiKeySource = "environment" | "config" | null;

export interface AnthropicAuthConfig {
  method: AnthropicAuthMethod;
  apiKey: string | null;
  apiKeySource: AnthropicApiKeySource;
  error: string | null;
}

interface RawAnthropicAuthConfig {
  method?: unknown;
  apiKey?: unknown;
}

/**
 * Resolve Anthropic authentication without throwing during module import.
 * ANTHROPIC_API_KEY remains the highest-precedence, backwards-compatible path;
 * otherwise ~/.tomo/config.json may select subscription or store an API key.
 * Invalid/incomplete file config is reported by assertAuthConfigured at daemon
 * startup so commands such as `tomo config` remain available to repair it.
 */
export function parseAnthropicAuthConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): AnthropicAuthConfig {
  const configured = isRecord(raw) ? raw as RawAnthropicAuthConfig : {};
  const envApiKey = cleanString(env.ANTHROPIC_API_KEY);
  const configuredApiKey = cleanString(configured.apiKey);

  if (envApiKey) {
    return {
      method: "api-key",
      apiKey: envApiKey,
      apiKeySource: "environment",
      error: null,
    };
  }

  const rawMethod = cleanString(configured.method);
  if (rawMethod && !isAnthropicAuthMethod(rawMethod)) {
    return {
      method: "subscription",
      apiKey: configuredApiKey,
      apiKeySource: configuredApiKey ? "config" : null,
      error: `Invalid Anthropic auth method "${rawMethod}". Run 'tomo config' and choose Claude subscription or API key.`,
    };
  }

  const method = rawMethod as AnthropicAuthMethod | null
    ?? (configuredApiKey ? "api-key" : "subscription");
  const error = method === "api-key" && !configuredApiKey
    ? "Anthropic API key authentication is selected, but no API key is configured. Run 'tomo config' or set ANTHROPIC_API_KEY."
    : null;

  return {
    method,
    apiKey: configuredApiKey,
    apiKeySource: configuredApiKey ? "config" : null,
    error,
  };
}

export function anthropicAuthLabel(method: AnthropicAuthMethod): string {
  return method === "api-key" ? "Anthropic API key" : "Claude subscription";
}

function isAnthropicAuthMethod(value: string): value is AnthropicAuthMethod {
  return (ANTHROPIC_AUTH_METHODS as readonly string[]).includes(value);
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
