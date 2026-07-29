# Claude Code subagents

Harness behaviour this project depends on. Verified against Claude Code 2.1.220
by inspecting live session transcripts and by direct testing, not from
documentation alone. Anything Anthropic may change without notice is marked.

## Dispatch and results

The `Agent` tool never blocks. It returns harness metadata immediately; the
actual result arrives later as a synthetic user-role message tagged
`origin.kind: "task-notification"`, carrying only the agent's **final text**
inside a `<result>` element. The agent's full transcript never enters the
parent's context.

`run_in_background: false` therefore does not mean a blocking call. It is turn
management, and a running foreground agent can be pushed to the background with
Ctrl+B.

## Background children are not kept alive

Bash background tasks and subagents share one notification queue, but they are
not equivalent:

| | Agent | Bash background |
| --- | --- | --- |
| Notification | `<task-notification>` | same |
| Result payload | final text inlined | none, read the output file |
| Fleet-view row | yes | no |

**A background Bash child launched inside a subagent is killed when that agent's
turn ends.** Tested directly: the child died mid-work with no output. This is
the single most important fact for anything that runs long work from a subagent,
and is why this project detaches instead. See `design.md`.

## Agent definitions

Files in `~/.claude/agents/*.md`, YAML frontmatter plus a markdown body that
becomes the system prompt. Only `name` and `description` are required.

Fields used here: `name`, `description`, `model`, `tools`, `permissionMode`,
`maxTurns`, `color`. Others available: `disallowedTools`, `skills`, `mcpServers`,
`hooks`, `memory`, `background`, `effort`, `isolation`, `initialPrompt`.

Notes that matter:

- `description` alone drives proactive auto-delegation. There is no separate
  flag.
- `skills` preloads content; it is not an access-control list.
- Subagents always lose a fixed set of tools regardless of `tools`, including
  `AskUserQuestion` and `Workflow`. Background subagents lose more, though
  `Bash` survives.
- The registry merges built-in, plugin, user, project, flag, and policy agents
  into one alphabetically sorted namespace, so a user-defined agent is a true
  peer of the built-ins.

**The registry is read at session start.** Editing an installed agent has no
effect until Claude Code restarts. For iteration without restarting, drive a
fresh headless session:

```bash
claude -p --allowedTools "Agent,Bash,Read,Write" "Dispatch the codex subagent with ..."
```

## Plugin agents are weaker than user agents

Plugin-provided agents go through a different parser, which drops
`permissionMode`, `hooks`, and `mcpServers` with a warning, and recognises only
`isolation: worktree`. Everything else, including the fleet-view row and
auto-delegation, is identical.

Plugin agents are namespaced `plugin:name`. Anthropic's own `plugin-dev` skill
claims top-level plugin agents get no prefix; the running system contradicts
that, so treat the prefix as always applied.

## Continuation

`SendMessage` addressed to an agent resumes it, including one that has already
finished, which resumes from its transcript with full history. That is how this
project continues a Codex thread: the wrapper recovers the `thread_id` it
previously reported and passes it to `--resume`.

Subagent transcripts live in separate files from the main conversation, so
compaction does not affect them.

## Uninstall conventions

Claude Code has no `uninstall` command. Its documented removal is two stages:
remove the program using whatever installed it, then remove configuration as a
separate step behind an explicit warning. `~/.claude` survives an uninstall by
design.

For plugins, `uninstall` removes registration and generated data, but leaves the
re-fetchable source cache and the marketplace registration. Confirmation is
gated by blast radius: a targeted removal does not prompt, while a wide purge
prints an itemised plan and asks once.

This project follows the same shape.
