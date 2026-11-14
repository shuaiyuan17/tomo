import { describe, expect, it } from "vitest";
import { MASK, redactCommand } from "../src/web/redact-command.js";

describe("redactCommand", () => {
  it.each([
    ["assignment", "FOO=bar npm test", "bar"],
    ["sensitive variable", "export GITHUB_TOKEN=abc123 && gh pr list", "abc123"],
    ["quoted value", "API_KEY='x y z' node a.js", "x y z"],
    ["--token value", "gh auth login --token abcdef123", "abcdef123"],
    ["--password=value", "mysql --password=hunter2 -u root", "hunter2"],
    ["--api-key value", "tool --api-key k_123 run", "k_123"],
    ["Authorization header", "curl -H 'Authorization: Bearer abc.def.ghi' https://x", "abc.def.ghi"],
    ["sk- key", "echo sk-ant-api03-" + "A".repeat(20), "sk-ant-api03"],
    ["ghp_ token", "git push https://ghp_" + "a".repeat(30) + "@github.com/x", "ghp_aaaa"],
    ["tomo_web_ token", "curl ?t=tomo_web_" + "b".repeat(64), "tomo_web_bbbb"],
    ["URL token parameter", "curl 'https://x.test/api?token=t0k3n&q=1'", "t0k3n"],
    ["URL access_token / key parameters", "curl https://x.test/a?access_token=AAA111&key=KKK222", "AAA111"],
    ["private memory path", "cat ~/.tomo/workspace/memory/private/people/x.md | head", "people/x.md"],
  ])("%s", (_name, input, secret) => {
    const out = redactCommand(input);
    expect(out).not.toContain(secret);
    expect(out).toMatch(new RegExp(`${MASK}|<private>`));
  });

  it.each([
    ["FOO=bar npm test", `FOO=${MASK} npm test`],
    ["gh auth login --token abcdef123", `gh auth login --token ${MASK}`],
    ["mysql --password=hunter2 -u root", `mysql --password=${MASK} -u root`],
    ["cat ~/.tomo/workspace/memory/private/people/x.md | head", "cat <private> | head"],
    ["git status", "git status"],
  ])("exactly: %s", (input, expected) => expect(redactCommand(input)).toBe(expected));

  it("is applied to the full description before the tracker clips it, so no half value survives", async () => {
    const { TaskTracker, TASK_TEXT_LIMIT } = await import("../src/agent/task-tracker.js");
    const secret = "Z".repeat(80);
    // The secret straddles the clip point: redacting after clipping would leave its first half.
    const command = `${"x".repeat(TASK_TEXT_LIMIT - 40)} && API_TOKEN='${secret}' deploy`;
    const t = new TaskTracker(() => 0);
    t.apply({ subtype: "background_tasks_changed", tasks: [{ task_id: "b1", task_type: "local_bash", description: command }] });
    const shown = t.list()[0].description;
    expect(shown.length).toBeLessThanOrEqual(TASK_TEXT_LIMIT + 1);
    expect(shown).not.toContain("ZZZZ");
  });
});
