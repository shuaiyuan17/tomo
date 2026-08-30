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
    const paths = createRuntimePaths({ homeDir: "/Users/tester", env: {} });

    expect(paths.tomoHome).toBe("/Users/tester/.tomo");
    expect(paths.workspaceDir).toBe("/Users/tester/.tomo/workspace");
    expect(paths.sessionsDir).toBe("/Users/tester/.tomo/data/sessions");
    expect(paths.sdkSessionsDir).toContain("/Users/tester/.claude/projects/");
    expect(paths.ignoredEnvOverrides).toEqual([]);
  });

  it("ignores a blank workspace/session override and reports it by name", () => {
    // resolve("") is the current working directory — a blank TOMO_WORKSPACE
    // used to make wherever the daemon was launched from the workspace.
    const paths = createRuntimePaths({
      homeDir: "/Users/tester",
      env: { TOMO_WORKSPACE: "", SESSIONS_DIR: "   " },
    });
    expect(paths.workspaceDir).toBe("/Users/tester/.tomo/workspace");
    expect(paths.sessionsDir).toBe("/Users/tester/.tomo/data/sessions");
    expect(paths.ignoredEnvOverrides).toEqual(["TOMO_WORKSPACE", "SESSIONS_DIR"]);
  });

  it("resolves relative workspaces before encoding the SDK project path", () => {
    expect(sdkSessionsDirForWorkspace("custom-workspace", "/Users/tester")).toBe(
      join("/Users/tester", ".claude", "projects", resolve("custom-workspace").replace(/[/.]/g, "-")),
    );
  });

  it("owns and normalizes workspace/session environment overrides", () => {
    const paths = createRuntimePaths({
      homeDir: "/Users/tester",
      env: {
        TOMO_WORKSPACE: "relative-workspace/",
        SESSIONS_DIR: "relative-sessions/",
      },
    });

    expect(paths.workspaceDir).toBe(resolve("relative-workspace"));
    expect(paths.sessionsDir).toBe(resolve("relative-sessions"));
    expect(paths.sdkSessionsDir).toBe(
      join(
        "/Users/tester",
        ".claude",
        "projects",
        resolve("relative-workspace").replace(/[/.]/g, "-"),
      ),
    );
  });
});
