import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHomeTools, HOME_TOOL_REFUSAL, resolveHomeFile } from "../src/mcp/home-tools.js";
import { HomeService } from "../src/home/service.js";
import { WatchBus } from "../src/watch/bus.js";
import type { WebEvent } from "../src/web/protocol.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
type Result = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
interface ToolHandle { name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<Result> }

let root: string, workspace: string;
let service: HomeService | undefined;
let allowed = true;
const good = { version: 1, room: { size: [5, 3, 5], floor: "#333333", walls: "#eeeeee" }, objects: [{ id: "cube", shape: "box", at: [0, 0, 0] }] };

function tool(withService = true): ToolHandle {
  const tools = buildHomeTools({ workspaceDir: workspace, allowed: () => allowed, service: () => withService ? service : undefined }) as unknown as ToolHandle[];
  return tools.find((t) => t.name === "home_check")!;
}
const text = (result: Result) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

beforeEach(() => {
  allowed = true;
  root = mkdtempSync(join(tmpdir(), "tomo-home-tool-"));
  workspace = join(root, "workspace");
  mkdirSync(join(workspace, "memory", "private"), { recursive: true });
  service = new HomeService({ workspaceDir: workspace, lastGoodPath: join(root, "last.json"), bus: new WatchBus(), pollMs: 60_000 });
  service.start();
});
afterEach(() => { service?.stop(); rmSync(root, { recursive: true, force: true }); });

describe("home_check", () => {
  it("is refused for a turn that is not the owner's own, before reading anything", async () => {
    allowed = false;
    const result = await tool().handler({}, {});
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(HOME_TOOL_REFUSAL);
  });

  it("checks the live scene: no problems, a floor plan, and says plainly there is no picture without a browser", async () => {
    writeFileSync(join(workspace, "home", "scene.json"), JSON.stringify(good));
    service!.attachWeb({ publish: () => {}, available: () => false, mayShowTask: () => false });
    const result = await tool().handler({}, {});
    expect(result.isError).toBeUndefined();
    const out = text(result);
    expect(out).toContain("home_check: home/scene.json: no problems.");
    expect(out).toContain("Floor plan from above");
    expect(out).toContain("[A] cube: box 1×1×1 m");
    expect(out).toContain("No browser has the Home page open right now, so there is no picture");
    expect(result.content.some((c) => c.type === "image")).toBe(false);
  });

  it("with a browser open, asks for a picture and returns it as an image", async () => {
    const asks: WebEvent[] = [];
    service!.attachWeb({ publish: (e) => {
      asks.push(e);
      if (e.type === "home-look") setTimeout(() => service!.deliverSnapshot({ requestId: e.requestId, revision: service!.store.view().revision, png: PNG.toString("base64") }), 10);
    }, available: () => true, mayShowTask: () => false });
    service!.web(); // a page read GET /home just now
    const result = await tool().handler({}, {});
    expect(asks.some((e) => e.type === "home-look")).toBe(true);
    const picture = result.content.find((c) => c.type === "image");
    expect(picture).toEqual({ type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
    expect(text(result)).toContain("Picture: below, as an open Home page drew it.");
  });

  it("reports problems, still draws the plan when the shape is readable, and says the room keeps the last good scene", async () => {
    writeFileSync(join(workspace, "home", "scene.json"), JSON.stringify({ ...good, objects: [{ id: "cube", kind: "nope" }] }));
    service!.attachWeb({ publish: () => {}, available: () => false, mayShowTask: () => false });
    const out = text(await tool().handler({}, {}));
    expect(out).toContain("1 problem");
    expect(out).toContain('kind "nope" is not defined');
    expect(out).toContain("the home keeps showing the last good scene");
    expect(out).toContain("Floor plan from above");
    writeFileSync(join(workspace, "home", "scene.json"), "{");
    expect(text(await tool().handler({}, {}))).toContain("No floor plan: the file is not yet in the scene format.");
  });

  it("with the web UI up but no read of /home in the last 90 s: no home-look, no wait", async () => {
    const publish = vi.fn();
    service!.attachWeb({ publish, available: () => true, mayShowTask: () => false });
    const started = Date.now();
    const out = text(await tool().handler({}, {}));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out).toContain("No browser has the Home page open right now");
    expect(publish.mock.calls.some(([e]) => e.type === "home-look")).toBe(false);
  });

  it("checks a draft in home/ without asking for a picture", async () => {
    writeFileSync(join(workspace, "home", "draft.json"), JSON.stringify(good));
    const publish = vi.fn();
    service!.attachWeb({ publish, available: () => true, mayShowTask: () => false });
    for (const file of ["draft.json", "home/draft.json", join(workspace, "home", "draft.json")]) {
      const out = text(await tool().handler({ file }, {}));
      expect(out).toContain("home/draft.json: no problems");
      expect(out).toContain("This is a draft");
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it("confines the draft path to home/", async () => {
    writeFileSync(join(workspace, "memory", "private", "secret.json"), JSON.stringify({ ...good, name: "secret" }));
    symlinkSync(join(workspace, "memory", "private", "secret.json"), join(workspace, "home", "linked.json"));
    for (const file of ["../memory/private/secret.json", join(workspace, "memory", "private", "secret.json"), "/etc/passwd", "assets/x.json",
      ".last-good.json", "home/../memory/private/secret.json", "draft.txt", "a/b.json"]) {
      const result = await tool().handler({ file }, {});
      expect([file, result.isError]).toEqual([file, true]);
      expect(text(result)).not.toContain("Floor plan");
    }
    const linked = await tool().handler({ file: "linked.json" }, {});
    expect(linked.isError).toBe(true);
    expect(text(linked)).toContain("is a link");
    expect(text(linked)).not.toContain('"secret"');
    expect(resolveHomeFile(undefined, workspace)).toEqual({ name: "scene.json" });
    expect(resolveHomeFile("~/.tomo/workspace/home/v2.json", workspace)).toEqual({ name: "v2.json" });
  });

  it("without the home service there is still a check and a plan, and no picture", async () => {
    const out = text(await tool(false).handler({}, {}));
    expect(out).toContain("no problems");
    expect(out).toContain("The home is not running in this daemon");
  });
});

describe("home_check registration", () => {
  afterEach(() => { vi.doUnmock("../src/config.js"); vi.resetModules(); });
  it("only the owner's DM session gets the tool", async () => {
    vi.resetModules();
    vi.doMock("../src/config.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/config.js")>();
      return { ...actual, config: { ...actual.config, owner: { name: "owner", telegram: [], imessage: [] }, workspaceDir: workspace } };
    });
    const { createTomoInternalMcpServer } = await import("../src/mcp/internal-server.js");
    const agent = { isOwnAudienceTurn: () => true, scopedCallerKey: (k: string) => k, sdkSessionIdFor: () => undefined } as never;
    const names = (key: string) => Object.keys((createTomoInternalMcpServer(agent, key).instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    expect(names("dm:owner")).toContain("home_check");
    expect(names("telegram:-100123")).not.toContain("home_check");
    expect(names("imessage:any;+;chat1")).not.toContain("home_check");
    expect(names("dm:someone-else")).not.toContain("home_check");
  });
});
