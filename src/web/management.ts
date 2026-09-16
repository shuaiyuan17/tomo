import { redactSecrets } from "../redact.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { ConfigStore, ConfigConflictError } from "../config/store.js";
import { configFields, ConfigValidationError, validateFileConfig, type ConfigField } from "../config/file-schema.js";
import { mcpServerName } from "../config/schema.js";
import { WebError } from "./protocol.js";

export interface SafeField extends ConfigField { runningSet?: boolean; set: boolean; value?: unknown; running?: unknown; overridden?: boolean }
export interface RunningConfig { revision: string; fields: Record<string, { value?: unknown; set: boolean; overridden: boolean }> }
export interface ConfigView { revision: string; restartRequired: boolean; fields: SafeField[] }
export interface ConfigDiff { field: string; before: unknown; after: unknown; secret: boolean }
export interface ConfigPreview { id: string; revision: string; diff: ConfigDiff[]; expiresAt: number; restartRequired: true; webChange: boolean }
const segment = z.string().min(1).max(128).refine((p) => !["__proto__", "prototype", "constructor"].includes(p));
export const configPreviewSchema = z.object({ revision: z.string().length(64), changes: z.array(z.object({
  path: z.array(segment).min(1).max(8), value: z.unknown().optional(), remove: z.boolean().optional(),
}).strict()).min(1).max(100) }).strict();
export const mcpPreviewSchema = z.object({ revision: z.string().length(64), name: mcpServerName,
  operation: z.enum(["save", "remove", "enable"]), enabled: z.boolean().optional(), values: z.record(segment, z.unknown()).optional(),
}).strict();
export const applySchema = z.object({ id: z.uuid() }).strict();
export const restartSchema = z.object({ revision: z.string().length(64), reason: z.string().trim().min(1).max(240), confirm: z.literal(true) }).strict();
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export function valueAt(value: unknown, path: string[]): unknown {
  for (const part of path) { if (!record(value) || !Object.hasOwn(value, part)) return undefined; value = value[part]; }
  return value;
}
function changeAt(value: Record<string, unknown>, path: string[], replacement: unknown, remove = false): void {
  let target = value;
  for (const part of path.slice(0, -1)) {
    if (!record(target[part])) target[part] = {};
    target = target[part] as Record<string, unknown>;
  }
  if (remove) delete target[path.at(-1)!]; else target[path.at(-1)!] = replacement;
}
function safeValue(field: ConfigField, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!["string", "number", "boolean"].includes(typeof value)) return false;
  if (typeof value === "string" && redactSecrets(value) !== value) return false;
  if (field.options && !field.options.includes(String(value))) return false;
  return true;
}
function isSet(value: unknown): boolean { return value !== undefined && value !== null && value !== ""; }
const SAFE_MCP = new Set(["type", "enabled", "disabled", "timeout", "alwaysLoad"]);
export const mcpFields: ConfigField[] = [
  { path: ["type"], label: "Transport", kind: "text", options: ["stdio", "http", "sse", "streamable-http"] },
  ...["command", "url"].map((key): ConfigField => ({ path: [key], label: key, kind: "text", secret: true })),
  ...["args", "env", "headers", "oauth", "tools"].map((key): ConfigField => ({ path: [key], label: key, kind: "json", secret: true })),
  { path: ["timeout"], label: "Timeout", kind: "number" }, { path: ["alwaysLoad"], label: "Always load", kind: "boolean" },
];
/** Explicit safelist: opaque extension values and credential-bearing collections
 * never cross the API, even when their key is not named token/password. */
function fieldsFor(value: Record<string, unknown>, definitions = configFields): ConfigField[] {
  const fields = definitions.map((field) => ({ ...field, secret: field.secret || field.kind === "json" }));
  const visit = (current: Record<string, unknown>, path: string[]) => {
    for (const [key, child] of Object.entries(current)) {
      const next = [...path, key];
      if (fields.some((f) => JSON.stringify(f.path) === JSON.stringify(next))) continue;
      if (record(child) && definitions.some((f) => next.every((part, i) => f.path[i] === part))) visit(child, next);
      else fields.push({ path: next, label: next.join("."), kind: "json", secret: true });
    }
  };
  visit(value, []); return fields;
}
export function runningConfigSnapshot(cfg: Record<string, unknown>, revision: string, env: NodeJS.ProcessEnv): RunningConfig {
  return { revision, fields: Object.fromEntries(configFields.map((field) => {
    const value = field.runningKey ? cfg[field.runningKey] : valueAt(cfg, field.path);
    return [field.label, { set: isSet(value), ...(field.secret || field.kind === "json" || !safeValue(field, value) ? {} : { value }), overridden: !!(field.env && env[field.env]?.trim()) }];
  })) };
}
interface Proposal { browser: string; value: Record<string, unknown>; preview: ConfigPreview }
export class WebManagement {
  private readonly store: ConfigStore;
  private proposals = new Map<string, Proposal>();
  constructor(tomoHome: string, private readonly running?: RunningConfig, private readonly now = Date.now) {
    this.store = new ConfigStore(join(tomoHome, "config.json"), undefined, 1_000);
  }
  config(): ConfigView {
    const { value, revision } = this.store.read();
    return { revision, restartRequired: revision !== this.running?.revision,
      fields: fieldsFor(value).map((field) => {
        const saved = valueAt(value, field.path); const live = this.running?.fields[field.label];
        const secret = field.secret || !safeValue(field, saved);
        return { ...field, secret, set: isSet(saved), runningSet: live?.set, ...(secret ? {} : { value: saved, running: live?.value }), overridden: live?.overridden };
      }) };
  }
  schema() { return { fields: configFields, mcpFields }; }
  mcp() {
    const { value, revision } = this.store.read(); const saved = value.mcpServers ?? (record(value.mcp) ? value.mcp.servers : undefined);
    return { revision, restartRequired: revision !== this.running?.revision,
      servers: record(saved) ? Object.entries(saved).map(([name, server]) => ({ name,
        enabled: record(server) && server.enabled !== false && server.disabled !== true,
        fields: fieldsFor(record(server) ? server : {}, mcpFields).map((field): SafeField => {
          const content = valueAt(server, field.path);
          // Extra values are opaque even if another object happens to reuse a safe key.
          const secret = field.secret || field.path.length !== 1 || !SAFE_MCP.has(field.path[0]) || !safeValue(field, content);
          return { ...field, secret, set: isSet(content), ...(secret ? {} : { value: content }) };
        }),
      })) : [] };
  }
  previewConfig(raw: unknown, browser: string): ConfigPreview {
    const parsed = configPreviewSchema.safeParse(raw);
    if (!parsed.success) throw new WebError(400, "invalid_changes");
    const current = this.store.read();
    if (current.revision !== parsed.data.revision) throw new WebError(409, "config_changed");
    const candidate = structuredClone(current.value); const fields = fieldsFor(current.value); const diff: ConfigDiff[] = [];
    const seen = new Set<string>();
    for (const change of parsed.data.changes) {
      const id = JSON.stringify(change.path); const definition = fields.find((f) => JSON.stringify(f.path) === id);
      const field = definition && { ...definition, secret: definition.secret || !safeValue(definition, valueAt(current.value, change.path)) };
      if (!field || seen.has(id) || (change.remove && field.secret) || (!change.remove && change.value === undefined)) throw new WebError(400, "invalid_changes");
      seen.add(id); const before = valueAt(current.value, change.path);
      changeAt(candidate, change.path, change.value, change.remove);
      diff.push({ field: field.label, before: field.secret ? isSet(before) ? "Set" : "Unset" : before ?? "Default",
        after: field.secret ? "Replacement supplied" : change.remove ? "Default" : change.value, secret: !!field.secret });
    }
    return this.propose(candidate, current.revision, diff, browser, parsed.data.changes.some((c) => c.path[0] === "web"));
  }
  previewMcp(raw: unknown, browser: string): ConfigPreview {
    const parsed = mcpPreviewSchema.safeParse(raw);
    if (!parsed.success) throw new WebError(400, "invalid_server");
    const { name, operation, values, enabled } = parsed.data;
    const current = this.store.read(); if (current.revision !== parsed.data.revision) throw new WebError(409, "config_changed");
    const value = structuredClone(current.value);
    const path = value.mcpServers !== undefined ? ["mcpServers"] : record(value.mcp) && value.mcp.servers !== undefined ? ["mcp", "servers"] : ["mcpServers"];
    const original = valueAt(value, path); const servers = record(original) ? original : {};
    const previous = servers[name]; const diff: ConfigDiff[] = [];
    if (operation === "remove") {
      if (!previous) throw new WebError(404, "server_not_found");
      delete servers[name]; diff.push({ field: name, before: "Configured", after: "Removed", secret: false });
    } else if (operation === "enable") {
      if (!record(previous) || enabled === undefined) throw new WebError(400, "invalid_server");
      servers[name] = { ...previous, enabled, disabled: !enabled };
      diff.push({ field: `${name}.enabled`, before: previous.enabled !== false && previous.disabled !== true, after: enabled, secret: false });
    } else {
      if (!values || Object.keys(values).some((key) => !mcpFields.some((f) => f.path[0] === key) && !(record(previous) && Object.hasOwn(previous, key)))) throw new WebError(400, "invalid_server");
      servers[name] = { ...(record(previous) ? previous : { enabled: true }), ...values };
      for (const [key, next] of Object.entries(values)) {
        const definition = mcpFields.find((field) => field.path[0] === key);
        const secret = !SAFE_MCP.has(key) || !definition || !safeValue(definition, valueAt(previous, [key]));
        diff.push({ field: `${name}.${key}`, secret, before: secret ? isSet(valueAt(previous, [key])) ? "Set" : "Unset" : valueAt(previous, [key]) ?? "Default", after: secret ? "Replacement supplied" : next });
      }
    }
    changeAt(value, path, servers);
    return this.propose(value, current.revision, diff, browser, false);
  }
  private propose(value: Record<string, unknown>, revision: string, diff: ConfigDiff[], browser: string, webChange: boolean): ConfigPreview {
    try { validateFileConfig(value, this.store.read().value); }
    catch (err) { if (err instanceof ConfigValidationError) throw new WebValidationError(err.fields); throw err; }
    for (const [id, proposal] of this.proposals) if (proposal.preview.expiresAt <= this.now()) this.proposals.delete(id);
    if (this.proposals.size >= 16) throw new WebError(429, "preview_limit");
    const preview: ConfigPreview = { id: randomUUID(), revision, diff, expiresAt: this.now() + 5 * 60_000, restartRequired: true, webChange };
    this.proposals.set(preview.id, { browser, value, preview }); return preview;
  }
  apply(raw: unknown, browser: string) {
    const parsed = applySchema.safeParse(raw); if (!parsed.success) throw new WebError(400, "invalid_preview");
    const proposal = this.proposals.get(parsed.data.id);
    if (!proposal || proposal.browser !== browser || proposal.preview.expiresAt <= this.now()) throw new WebError(409, "preview_expired");
    try {
      const saved = this.store.update((current) => {
        validateFileConfig(proposal.value, current); return proposal.value;
      }, proposal.preview.revision);
      this.proposals.delete(parsed.data.id); return { revision: saved.revision, restartRequired: true };
    } catch (error) {
      if (error instanceof ConfigConflictError) throw new WebError(409, "config_changed");
      if (error instanceof ConfigValidationError) throw new WebValidationError(error.fields);
      throw error;
    }
  }
  checkRevision(revision: string): void { if (this.store.read().revision !== revision) throw new WebError(409, "config_changed"); }
}
export class WebValidationError extends WebError {
  constructor(readonly fields: string[]) { super(422, "invalid_config"); }
}
