import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { createRuntimePaths, sdkSessionsDirForWorkspace } from "../src/runtime-paths.js";

describe("runtime paths", () => {
  it("derives Claude SDK sessions from the configured workspace", () => {
    const homeDir = "/Users/tester";
    const workspaceDir = "/Volumes/External/tomo.workspace";

    expect(sdkSessionsDirForWorkspace(workspaceDir, homeDir)).toBe(
      join(homeDir, ".claude", "projects", "-Volumes-External-tomo-workspace"),
    );
  });

  it("keeps all default Tomo paths rooted under the selected home", () => {
    const paths = createRuntimePaths({ homeDir: "/Users/tester" });

    expect(paths.tomoHome).toBe("/Users/tester/.tomo");
    expect(paths.workspaceDir).toBe("/Users/tester/.tomo/workspace");
    expect(paths.sessionsDir).toBe("/Users/tester/.tomo/data/sessions");
    expect(paths.sdkSessionsDir).toContain("/Users/tester/.claude/projects/");
  });

  it("resolves relative workspaces before encoding the SDK project path", () => {
    expect(sdkSessionsDirForWorkspace("custom-workspace", "/Users/tester")).toBe(
      join("/Users/tester", ".claude", "projects", resolve("custom-workspace").replace(/[/.]/g, "-")),
    );
  });
});
