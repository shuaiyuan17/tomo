import { describe, expect, it } from "vitest";
import { shellShortName, shortenPaths, SHORT_NAME_MAX } from "../web/src/shell.js";

describe("shell task short names", () => {
  it.each([
    ["cd /Volumes/Claw/worktrees/tomo-shadcn && git switch -q -c feat/x origin/main", "git switch"],
    ["~/.tomo/workspace/scripts/wait-ci.sh ~/Developer/tomo 490", "wait-ci.sh 490"],
    ["cd /repo && python3 - <<'EOF'\nprint(1)\nEOF", "python3 (heredoc)"],
    ["sleep 30; ~/.tomo/workspace/scripts/wait-ci.sh ~/Developer/tomo 487", "sleep 30; wait-ci.sh 487"],
    ["FOO=1 BAR=2 npm test -- tests/web-http.test.ts", "npm test"],
    ["cat package.json | grep version", "cat | grep"],
    ["npx vitest run tests/a.test.ts", "npx vitest"],
    ["ls -la", "ls"],
    ["cd /tmp", "cd /tmp"],
    ["(cd /tmp && npm test)", "npm test"],
    ["(cd /tmp && npm test) && echo ok", "npm test"],
    ["echo $(git rev-parse HEAD && date) | wc -c", "echo | wc"],
    ["printf 'a;b|c' && git log", "printf"],
    ["echo a\\;b && git status", "echo"],
    ["FOO=1", "FOO=1"],
  ])("%s → %s", (command, name) => expect(shellShortName(command)).toBe(name));

  it("never exceeds the length cap", () => {
    expect(shellShortName(`some-really-long-command-name-that-goes-on-and-on-forever --flag`).length).toBeLessThanOrEqual(SHORT_NAME_MAX);
  });

  it("shortens home and deep paths", () => {
    expect(shortenPaths("cd /Users/shuaiyuan/Developer/tomo && ls")).toBe("cd …/tomo && ls");
    expect(shortenPaths("cat /Users/alex/notes.txt")).toBe("cat ~/notes.txt");
    expect(shortenPaths("cd /Volumes/Claw/worktrees/tomo-shadcn")).toBe("cd …/tomo-shadcn");
    expect(shortenPaths("echo hi")).toBe("echo hi");
  });
});
