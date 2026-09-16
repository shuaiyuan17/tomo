import { z } from "zod";

export const webConfigSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().int().min(1).max(65535).default(9465),
  ownerIdentity: z.string().trim().min(1).optional(),
  externalOrigin: z.string().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value && url.hostname.endsWith(".ts.net")
        && !url.username && !url.password && !url.hostname.includes("*");
    } catch { return false; }
  }, "expected an exact HTTPS Tailscale Serve origin").optional(),
});
export type WebConfig = z.infer<typeof webConfigSchema>;

/** Optional UI settings must never turn an otherwise valid daemon off. */
export function parseWebConfig(raw: unknown, diagnostic?: (message: string) => void): WebConfig {
  const result = webConfigSchema.safeParse(raw === undefined ? {} : raw);
  if (result.success) return result.data;
  diagnostic?.("Invalid web settings; Web UI disabled. Check web.enabled, web.port, web.ownerIdentity, and web.externalOrigin.");
  return { enabled: false, port: 9465 };
}
