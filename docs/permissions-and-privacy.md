# Permissions and privacy

Tomo runs the Claude Agent SDK with permissions bypassed, so in your own DM the model can do most of what your user account can. The controls on this page narrow that where it matters: group chats, subagents, and passwords. For the overall trust model and how to report a vulnerability, see [SECURITY.md](../SECURITY.md).

- [Private memory and group turns](#private-memory-and-group-turns)
- [Per-group sandbox settings](#per-group-sandbox-settings)
- [Permission requests from groups](#permission-requests-from-groups)
- [Credential broker](#credential-broker)
- [Per-agent permission scoping (`agentProfiles`)](#per-agent-permission-scoping-agentprofiles)

## Private memory and group turns

Memory lives in `~/.tomo/workspace/memory/`. Files under `memory/private/` (including private people records in `memory/private/people/`) are **DM-only**. They are stripped from the index a group session sees, and a `PreToolUse` guard blocks them from `Read`/`Grep`/`Glob` and from `MEDIA:` attachments for any turn a group is steering — a group session for its whole life, and your own DM session for the duration of a `/summon`.

Memory is shared by default: `MEMORY.md` and the topic files outside `memory/private/` are visible to group chats (in their prompt, or by reading them), and the Study shows them. What should stay between you and Tomo goes under `memory/private/`; the prompt lists what counts (health, money, home address and routine, relationships and family matters, other people's personal details, work that isn't public, anything you asked to keep to yourselves), and when Tomo creates a file outside `private/` or adds a line to `MEMORY.md`, the tool's reply reminds it that group chats can read it. `private/MEMORY.md` is loaded only into your own private conversation.

The memory tools follow the same bar: on a turn a group is steering they don't read, list, search or write anything under `memory/private/` (a path that leads there through a link included), and they don't change `MEMORY.md`. Such a turn writes only in its own group's folder, `memory/groups/<chat>/` (named in the group session's prompt and in each summoned message's reminder), and neither the memory tools nor the file tools read another group's folder there; a batch that mixes several chats writes nothing. The shell is held to this only in part: its sandbox closes `memory/private/` to reads and all of `memory/` to writes, so a sandboxed shell can still read another group's folder. Direct file writes to memory Markdown are refused on every session unless `memory.storeGuard` says otherwise ([Configuration](configuration.md#memory-writes)), and on such a turn whatever it says.

While a group is part of your DM session (a `/summon` is active, or a group's request was handed to it), that session also runs on a **shared prompt**: the same system prompt without `private/MEMORY.md`, without `memory/private/` in the memory files list, without the `MEMORY.md` lines that link into `memory/private/` and without private people records. Tomo reloads the session with that prompt before the group's turn runs, and goes back to the full prompt on your first private turn after the summon ends. Each reload restarts the session's process and costs one uncached read of the conversation. If the session cannot be reloaded because background work is running in it, your own turns carry on as they are, and a group's turn waits up to five minutes and is then answered with a fixed "busy" line (you get a notice); background work is never stopped for it. Rollups of the DM session are deferred while a group is summoned in. What a summon does not hide is unchanged: the conversation history of your DM session is in context, and group members can ask about it.

**Bash on group turns runs in a macOS sandbox.** Every command is run through a `sandbox-exec` profile, so a path assembled inside `python3 -c` fails with `EPERM` at the kernel instead of slipping past a filter over command text. The profile is deny-by-default:

- System directories are read-only; the workspace and the temp dirs are read-write; nothing else is reachable — not your home directory, not Tomo's config file, logs or state, not the login keychains or `~/.ssh`.
- `memory/private/` and the workspace's `secrets/` stay denied, as do writes to `home/` and `.claude/`.
- Outbound network works, but connections to localhost and to local Unix sockets do not (services on this machine run outside the sandbox).
- The shell gets only an allowlist of environment variables (PATH, HOME, locale and the like), never the credentials the daemon may carry. It starts without your shell start-up files (`zsh -f`), and git there ignores `~/.gitconfig`.
- The profile is passed inline on the command line, never written to a file — a file would be one more thing the sandboxed shell could edit.

The same path policy applies to `Read`/`Write`/`Edit`/`Grep`/`Glob` and to `MEDIA:` attachments on those turns, including the attachments in a group's final reply.

**Tomo's own state is closed the same way.** `~/.tomo/data/` (session transcripts, the inbox, the usage ledger, the cron store, and the sessions directory when it is relocated) holds every conversation, your DMs included. On group turns the file tools and `MEDIA:` attachments are refused there and the shell profile denies reads and writes under it. A group gets what it needs from that state through Tomo's tools, never by reading the files.

> [!WARNING]
> **If the sandbox cannot be set up, the Bash tool is withheld for the turn rather than run unsandboxed.** That covers a host without `sandbox-exec` (anything but macOS), a private directory whose real location cannot be established, and a workspace `.claude/settings.json` or enabled plugin that carries a `PreToolUse` hook. Such a hook can rewrite a tool's input after Tomo's own guard has answered, so a barred turn gets no shell rather than one whose sandbox a hook might have removed. If you want a shell on group turns, keep `PreToolUse` hooks out of the workspace settings.

## Per-group sandbox settings

Per group, `groupSandbox.groups["<session key>"]` can add `extraRead` / `extraWrite` directories (absolute or `~/` paths), or set `unsandboxed: true` for a group you fully trust:

```json
{
  "groupSandbox": {
    "groups": {
      "telegram:-1001234567890": { "extraRead": ["~/Projects/shared"], "extraWrite": ["~/Projects/shared/out"] },
      "imessage:any;+;<group-chat-guid>": { "unsandboxed": true }
    }
  }
}
```

An `unsandboxed` group's Bash runs as it does in your DM, including while it is summoned into your DM session, and its file tools keep only the private-memory guards. **That is full trust**: that shell can read any file you can. The older `groupShellAllowlist` (a list of session keys) is still read and means `unsandboxed: true` for each key not listed in `groupSandbox`.

## Permission requests from groups

A group turn that needs a path outside its sandbox can ask with `request_permission` (path, read or write, a reason). You get a four-line DM with a short code, and a card in the web UI, with three answers:

- **Allow once** — for the one turn that delivers your answer. It reaches only the main agent's file tools (Read, Write, Edit, Grep, Glob) in that turn: never the shell (a process it starts could outlive the turn) and not subagents.
- **Always allow** — added to that group's `extraRead` / `extraWrite` in `config.json`, with a backup. Shell access needs this.
- **Deny**.

In the DM, reply `1 <code>`, `2 <code>` or `3 <code>`, or quote the request and reply 1, 2 or 3; a bare reply does not count, and nothing said in a group ever does. A group has at most one open request, and one left unanswered for 5 minutes is denied. Paths no group may reach (private memory, `secrets/`, Tomo's own files, keychains, `~/.ssh`) are refused without asking.

Each Always allow gets a grant id (`G-XXXXXX`, shown in the confirmation and stored with it in `config.json`); reply `revoke G-XXXXXX` in your DM, or use the web endpoint `POST /api/v1/permissions/revoke`, to take it back. A revoke applies from the next tool call; a background command already running keeps the access it started with. Every request, answer and revocation is logged to `~/.tomo/data/permissions/group-requests.jsonl`; requests still open when Tomo stops are recorded as denied (restart) on the next start, and their groups are told.

## Credential broker

`{ "credentialBroker": { "enabled": true } }` (default `false`) keeps a password you send on request away from the model. The agent calls `request_credential`, and you are asked **where your message came from**:

- **iMessage**: your next message in that private chat is the value. It stays in Messages, so delete it there.
- **Telegram**: your next message in your private chat with the bot is the value, and Tomo deletes it from the chat (if Telegram refuses, you are told to delete it yourself).
- **Web UI**: a password card opens above the composer. What you type goes to its own endpoint, never into the chat, the request journal or the transcript.

A scheduled job, a heartbeat or a group turn cannot ask. The value goes in the login keychain (service `tomo-credential-broker`, account = the name), and the agent uses it in Bash only inside a command substitution, `"$(security find-generic-password -s tomo-credential-broker -a <name> -w)"`, so the command text never holds it. Known values are masked in every tool's output (a global `PostToolUse` hook) and in logs. While a request is open, your messages on the other chat channel are dropped (one of them may be the value) and you are told; the web chat keeps working.

> [!IMPORTANT]
> This prevents accidents. It does not stop a model trying to get the value: see [SECURITY.md](../SECURITY.md#credential-broker-what-it-does-not-stop).

## Per-agent permission scoping (`agentProfiles`)

Every session runs the Claude Agent SDK in `bypassPermissions` mode, and the SDK propagates that mode into subagents — so a subagent Tomo dispatches inherits your whole machine. `AgentDefinition` scopes **tools** and has no notion of a **path**, which means `tools: Read, Grep, Glob, Bash` on an agent described as "read-only reviewer" is a full shell.

`agentProfiles` fences that in, keyed by the agent type name (the `.claude/agents/<name>.md` filename). Enforcement is a `PreToolUse` hook, which the SDK consults *before* `canUseTool` and which a `bypassPermissions` session cannot skip.

```json
{
  "agentProfiles": {
    "ios-reviewer": {
      "writeRoots": [
        "~/.tomo/workspace/tmp",
        "/tmp",
        "/private/tmp",
        "$TMPDIR",
        "~/Library/Developer/Xcode/DerivedData",
        "~/Library/Developer/CoreSimulator",
        "~/Library/Caches"
      ],
      "denyPaths": [
        "~/Library/LaunchAgents",
        "/Applications",
        "~/.claude",
        "~/.tomo/workspace/memory",
        "~/.tomo/workspace/.claude",
        "~/Developer/bloom",
        "~/Developer/wayfound"
      ],
      "denyReadPaths": [
        "~/.ssh",
        "~/.tomo/config.json",
        "~/.tomo/workspace/memory/private"
      ],
      "bash": "readonly"
    },
    "ios-implementer": {
      "writeRoots": [
        "~/.tomo/workspace/tmp",
        "/tmp",
        "/private/tmp",
        "$TMPDIR",
        "~/Library/Developer/Xcode/DerivedData",
        "~/Library/Developer/CoreSimulator",
        "~/Library/Caches"
      ],
      "denyPaths": [
        "~/Library/LaunchAgents",
        "/Applications",
        "~/.claude",
        "~/.tomo/workspace/memory",
        "~/.tomo/workspace/.claude"
      ],
      "denyReadPaths": [
        "~/.ssh",
        "~/.tomo/config.json",
        "~/.tomo/workspace/memory/private"
      ],
      "bash": "worktree"
    }
  }
}
```

The two profiles differ in exactly two places, and both differences are the point. The reviewer cannot write the shared checkouts under `~/Developer` — but it can and must **read** them, which is why they sit on `denyPaths` and not `denyReadPaths`. The implementer has to write in one of them, so they are off its list entirely, and its Bash mode is `worktree` rather than `readonly`.

Both list `/tmp` **and** `/private/tmp` because `/tmp` is a symlink to the second on macOS, and both list `$TMPDIR` because `xcodebuild` and `simctl` write there constantly. Both fence `~/.tomo/workspace/memory` and `~/.tomo/workspace/.claude`, which is what makes `rm -rf memory` and `git clean -fdx` refusals rather than restore-from-backup — see "relative paths" below.

| Field | Meaning |
|-------|---------|
| `writeRoots` | Absolute roots the agent may write into. Empty (or omitted) means it may write nowhere — unless `bash` is `full`, which switches `writeRoots` off entirely. |
| `denyPaths` | A **write** fence: paths the agent may not write to, by file tool, write verb, or redirection. **Reads are unaffected.** Beats `writeRoots`, and a destructive verb aimed at an *ancestor* of one is denied too, because `rm -rf <parent>` takes the protected path with it. |
| `denyReadPaths` | The **secrets** list: paths the agent may not *name at all*, by any tool including `Read`/`Grep`/`Glob`. Strictly stronger than `denyPaths`; a path here needs no entry there. |
| `bash` | `none` \| `readonly` \| `worktree` \| `full`. Defaults to `none`. |

**Why two deny lists.** A reviewer's whole job is to read the checkouts it must never modify. One combined list forces you to choose between "the reviewer cannot review bloom" and "the reviewer can `rm -rf` bloom". `denyPaths` fences the write; `denyReadPaths` is kept for the short list of paths where *reading* is itself the harm.

### Bash modes

- **`none`** — the Bash tool is denied outright.
- **`readonly`** — a write must **name its destination**, and that destination must be inside `writeRoots`. So `touch /tmp/marker`, `mkdir -p /tmp/dd`, `cp /tmp/a /tmp/b` and `rm -rf /tmp/scratch` are allowed when `/tmp` is a writeRoot, while `rm -rf x`, `rm -rf *` and `mkdir build` are refused — nothing in the daemon can say where those land. `cp /tmp/a /Applications/x` is refused on the target. A `>`/`>>` redirection onto an *absolute* target outside `writeRoots` is refused the same way.

  The commands this recognises as writes: `rm`, `rmdir`, `mv`, `cp`, `tee`, `dd`, `chmod`, `chown`, `ln`, `mkdir`, `touch`, `truncate`, `install`, `unlink`, `shred`, `ditto`, `chflags`, `brew`, `launchctl`, `wget`, `sed -i`, `perl -i`, `find … -delete`, `rsync … --delete`, `curl -o|-O|--output`, `xattr -w|-d`, `git push|commit|checkout|reset|rebase|stash|clean|merge|apply`, `git worktree remove|prune`, `git config --global|--system`, `gh pr merge|close`, `npm install|publish|ci`, `defaults write`, `simctl delete|erase|shutdown|boot`, `xcodebuild clean`, `swift package reset|clean`.

  Command substitution, backticks and pipes are **allowed** — see the note below. `kill`/`killall`/`pkill` are **not** denied: a signal is not a filesystem write, and clearing a wedged simulator is routine reviewer work.
- **`worktree`** — `readonly` minus the must-name-it clause. An *absolute* path token on a write command must still land inside `writeRoots`, but a relative one is not judged, so `rm -rf build/Old` and `mkdir -p Sources/New` work inside the agent's own worktree.

  Both modes refuse a write verb pointed at a `denyPaths` entry, whatever the mode's own rule says — so `git worktree prune`, `git worktree remove ~/Developer/bloom/wt` and `git -C ~/Developer/bloom commit` are all refused for the reviewer profile above, while `git -C ~/Developer/bloom worktree list` and `git -C ~/Developer/bloom log` are not.
- **`full`** — only `denyPaths` and `denyReadPaths` apply, to Bash *and* to `Write`/`Edit`/`MultiEdit`/`NotebookEdit`.

`git reset --hard` (and `--merge`) and `git clean -fdx` get one extra rule, because they destroy the tree under the cwd while naming neither a path nor a `*`: both are treated as targeting the workspace directory for the deny check. That also refuses `git -C /some/worktree clean -fdx`, which is a real false positive and the conservative direction — guessing from a token scan which `-C`-shaped flag actually repointed the command is wrong in the direction that costs the tree.

### Relative paths, and what `worktree` mode does not fence

The daemon is never told where a subagent's worktree is — the Agent tool's `isolation: "worktree"` does not report the path back — so a relative token is a path whose destination is unknowable here. It is therefore **never judged on the allow side**: `mkdir -p Sources/New`, `rm -rf build/Old` and `git commit -m msg` all pass, which is what makes the mode usable at all. On the **deny side** a relative write target *is* resolved, against the workspace directory, because that is the cwd a subagent inherits when it has no worktree of its own — so `rm -rf memory`, `rm -rf *`, `rm -rf .` and `git clean -fdx` are refused when the workspace's own trees are on `denyPaths`. The consequence to be clear about: **a `worktree`-mode agent is fenced from the workspace, not from its own worktree.** It can destroy its own working copy, by design, and no rule here can tell it apart from the work it was sent to do.

### Path expansion and defaults

Paths are expanded at config load: `~`, `~/x`, `$VAR` and `${VAR}`. What happens to one that does not come out absolute depends on which list it is in, and the asymmetry is deliberate — a dropped `writeRoot` only *narrows* the agent, while a dropped deny entry *widens* it:

- a bad **`writeRoots`** entry is dropped with a `log.warn`. This is also what keeps an unset `$TMPDIR` (absent under a bare `launchctl load`) from bricking the daemon.
- a bad **`denyPaths`/`denyReadPaths`** entry is dropped with a `configIssues` entry, which **refuses daemon startup**.

An agent type with **no profile is unconstrained**. That is the deliberate v1 default: the real tool surface of `general-purpose`, `Explore` and ad-hoc delegations is not known yet, and failing closed would break all of them on the first turn. Instead the daemon logs one `warn` per session per unprofiled agent type, and logs *every* subagent Bash call at `info` with the agent type and the first 120 characters of the command. Read those logs before tightening the default.

### This is policy, not a sandbox

> [!WARNING]
> The checks run inside the Tomo daemon; the thing they constrain is a CLI child process, which is the wrong side of a trust boundary for real isolation. `readonly` deliberately permits `$(…)`, backticks and pipes, because a reviewer's normal working command is `git log $(git merge-base main HEAD)` and refusing substitution refuses the reviewer. A redirection inside a quoted sub-shell (`sh -c 'cat x > /etc/passwd'`) is invisible for the same reason — telling it apart from `awk '$1 > 5' f` means writing a shell parser. The verb list above is a *list*: it is long, it is still incomplete, and every entry is a command someone noticed. An agent that wants out gets out. What this closes is the *accident* — an agent that was told to review a PR deciding to delete a shared checkout, or to write into `/Applications` — which is the failure mode that actually happens.
