import { createHash } from "node:crypto";
import type { IdentityConfig } from "../config.js";

export function selectWebOwner(identities: IdentityConfig[], name?: string): IdentityConfig | undefined {
  const candidates = name === undefined ? identities
    : identities.filter((id) => id.name.toLowerCase() === name.toLowerCase());
  return candidates.length === 1 ? candidates[0] : undefined;
}
export function webSessionId(key: string): string {
  return createHash("sha256").update(key).digest("base64url");
}
