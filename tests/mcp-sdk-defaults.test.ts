import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTodoTools } from "../src/mcp/todo-tools.js";
import { buildPetTools } from "../src/mcp/pet-tools.js";
import { PetStore } from "../src/mcp/pet-store.js";
import { TodoStore } from "../src/todos/store.js";

/**
 * Defaulted tool arguments through the REAL Agent SDK registration path — no
 * SDK mock. `createSdkMcpServer` wraps our field schemas (built with the app's
 * zod) in an object schema built by the SDK's own bundled zod; when the two
 * disagree on how `.default()` marks a key optional, every omitted defaulted
 * argument fails with "expected nonoptional" (zod 4.5 vs an SDK bundling
 * 4.4, the reason zod was once pinned). This drives a real MCP client over the
 * in-process server, the same tools/list + tools/call the CLI does.
 */
let root: string;
let client: Client;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tomo-mcp-defaults-"));
  const petPath = join(root, "pet.json");
  const server = createSdkMcpServer({
    name: "defaults-test",
    version: "0.0.0",
    tools: [
      ...buildTodoTools({ store: () => new TodoStore(join(root, "todos")) }),
      ...buildPetTools(petPath),
    ],
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await (server.instance as unknown as { connect: (t: unknown) => Promise<void> }).connect(serverSide);
  client = new Client({ name: "defaults-test-client", version: "0.0.0" });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

const text = (result: unknown) =>
  (result as { content: Array<{ type: string; text?: string }> }).content.map((c) => c.text ?? "").join("\n");

describe("in-process MCP tools through the real SDK", () => {
  it("advertises a defaulted argument as optional, with its default, enum and description", async () => {
    const { tools } = await client.listTools();
    const todoList = tools.find((t) => t.name === "todo_list")!;
    const schema = todoList.inputSchema as { required?: string[]; properties: Record<string, Record<string, unknown>> };
    expect(schema.required ?? []).not.toContain("filter");
    expect(schema.properties.filter).toMatchObject({
      type: "string",
      enum: ["due", "mine", "owner", "all"],
      default: "all",
      description: "Which todos to list.",
    });
  });

  it("fills in an omitted defaulted argument instead of rejecting the call", async () => {
    const result = await client.callTool({ name: "todo_list", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe("No open todos.");
  });

  it("leaves an omitted optional argument to the handler's own default", async () => {
    const store = new PetStore(join(root, "pet.json"));
    store.save({ ...store.create("Pip", "cat"), stage: "baby" });
    const before = Date.now();
    const result = await client.callTool({ name: "pet_sleep", arguments: { action: "sleep" } });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Pip is sleeping until");
    const hours = (Date.parse(store.load()!.sleep_until!) - before) / 3_600_000;
    expect(hours).toBeGreaterThan(3.99);
    expect(hours).toBeLessThan(4.01);
  });
});
