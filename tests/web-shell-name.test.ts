import { describe, expect, it } from "vitest";
import { isProseDescription, PROSE_LABEL_MAX, shellLabel, shellShortName, shortenPaths, SHORT_NAME_MAX } from "../web/src/shell.js";

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

describe("shell task labels", () => {
  it.each([
    // A description in words is shown whole: not cut at its first space.
    ["用 stdin 重跑 codex 审 #539", "用 stdin 重跑 codex 审 #539"],
    ["重启后拉起", "重启后拉起"],
    ["Run the e2e suite --watch", "Run the e2e suite --watch"],
    ["Stream-extract tool calls", "Stream-extract tool calls"],
    // A command line keeps its short name.
    ["npm test", "npm test"],
    ["codex", "codex"],
    ["cd /tmp && 跑测试.sh", "跑测试.sh"],
    ["FOO=1 npm test", "npm test"],
    ["~/.tomo/workspace/scripts/wait-ci.sh ~/Developer/tomo 490", "wait-ci.sh 490"],
  ])("%s → %s", (description, label) => expect(shellLabel(description)).toBe(label));

  it("tells words from a command", () => {
    expect(isProseDescription("用 stdin 重跑 codex 审 #539")).toBe(true);
    expect(isProseDescription("Check CI")).toBe(true);
    expect(isProseDescription("git status")).toBe(false);
    expect(isProseDescription("Build | tee log")).toBe(false);
    expect(isProseDescription("")).toBe(false);
  });

  it("cuts a long sentence with an ellipsis, on one line", () => {
    const label = shellLabel(`用   stdin\t${"重跑".repeat(60)}`);
    expect(label.length).toBe(PROSE_LABEL_MAX);
    expect(label.endsWith("…")).toBe(true);
    expect(label.startsWith("用 stdin 重跑")).toBe(true);
  });
});
