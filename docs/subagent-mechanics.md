# How Claude Code Subagents Actually Work

Date: 2026-07-28
Claude Code version: 2.1.220 (a few internal-behaviour claims were traced
against 2.1.186 and are noted where relevant)

Researched to answer one question: can Codex be made to feel like a first-class
Claude Code subagent, rather than a fire-and-forget rescue button?

Evidence came from three angles run in parallel: official docs, the plugin and
CLI binary on disk, and live session transcripts. Where docs and local evidence
disagreed, local evidence won, and that is called out below.

## The Agent tool never blocks

The `Agent` tool_use returns immediately with harness-generated metadata
(agentId, output_file path), never the agent's work. Verified in a real parent
transcript.

The actual result arrives later as a **synthetic user-role message** injected
into the parent transcript:

```json
{
  "type": "user",
  "message": {"role": "user", "content": "<task-notification>...</task-notification>"},
  "origin": {"kind": "task-notification"},
  "promptSource": "system"
}
```

Before landing it briefly exists as a `"type":"queue-operation"` record
(`operation: enqueue`, then `remove`). There is a real pending-notification
queue, visible in the transcript as its own record type.

Only the agent's **final assistant text** is inlined, inside `<result>`. The
full transcript never enters the parent context.

`run_in_background: false` therefore does not mean a blocking API call. It is
turn-management: the harness holds the turn open. A human can promote a running
foreground agent to background with Ctrl+B mid-flight.

## Bash background and subagents share one substrate

This was disputed between sources and matters enough to record the resolution.

The docs researcher could not find documentation that Bash background tasks
re-invoke Claude, and flagged it as an assumption. The local-evidence researcher
found the opposite directly in transcripts, and the Bash tool's own contract
states it plainly ("keeps running across turns and re-invokes you when it
exits").

Aggregating every `queue-operation` / `task-notification` record across all
local projects, roughly 700 instances, by task-id prefix:

| Prefix | Kind | `<result>` inlined? |
| --- | --- | --- |
| `a...` (17 hex) | Agent-tool subagent | yes, 327 of 336 completed |
| `b...` (9 alnum) | Bash `run_in_background` | **never**, 0 of 313 |
| `w...` (9 alnum) | Dynamic workflow | yes, 4 of 4 |

Same queue, same notification pipeline, same `origin.kind` and `promptSource`
tagging.

But "same substrate" must not be read as "equivalent". Three axes differ, and
conflating them was an error made and corrected during this research:

| Axis | Agent | Bash background |
| --- | --- | --- |
| Notification queue | `<task-notification>` synthetic user message | **same**, transcript-verified |
| Result payload | final text inlined in `<result>` | never; must `Read` the file |
| **TUI fleet row** | **yes** | **no** |

The shared queue is transcript-proven. It says nothing about presentation.
Bash background tasks are deliberately **not** surfaced as first-class
participants in the fleet view: no row, no live token or elapsed counters, no
Ctrl+B management. Confirmed by direct user experience and by observing a live
fleet view during this session showing three agent rows and zero Bash rows.

So the gap between "dispatched a subagent" and "kicked off a shell job" is two
things, not one: the inlined result payload, and the fleet presence.

This is the core reason a Bash wrapper is the wrong *interface* no matter how
good it is as an *implementation*. Only an agent produces a fleet row.

Method note: absence of documentation is not evidence of absence. The docs
researcher could not find the shared-queue behaviour and called it an
assumption; transcripts proved it. Equally, transcript evidence about one axis
proved nothing about the others. Both errors are worth avoiding.

### The consequence that matters most

The notification note reads:

> A task-notification fires each time this agent stops with **no live background
> children of its own**.

This was read as a guarantee that an agent launching a background Bash child
stays alive and is re-invoked when the child exits, which would have removed the
Bash tool's 600000 ms cap as a constraint on long runs.

**That reading is wrong, and testing disproved it.** A `codex` subagent launched
a Codex run with `run_in_background: true` and ended its turn. The run was killed
mid-flight: `events.jsonl` stopped after two items, no answer file was written,
stderr was empty, and no process survived.

Inside a subagent, a background Bash child is torn down when the agent's turn
ends. The note describes when notifications fire, not a lifetime guarantee for
subagent-scoped children.

**The pattern that does work** detaches the real work from the caller's process
group entirely, then blocks in foreground chunks:

1. Launch with `setsid` so the work lives in its own session.
2. Return a handle (a run directory) immediately.
3. Block in **foreground** Bash calls, each under the 600000 ms cap, polling for
   a completion marker.
4. Re-enter the wait as many times as needed.

Verified: a `setsid`-detached run started in one Bash call survived its
launching shell exiting, was still running when checked from a separate
invocation, and completed correctly.

Cost: the agent must keep taking turns to wait, so `maxTurns` needs headroom.
Benefit: the work is no longer coupled to the agent's lifetime at all, so even
an agent that dies early leaves a recoverable run.

## Transcript layout

Two files per subagent run, keyed by harness-generated `agentId`
(format: `a` plus 16 hex chars):

```
~/.claude/projects/<project>/<parentSessionId>/subagents/
  agent-<agentId>.jsonl       # transcript, mode 600
  agent-<agentId>.meta.json   # mode 644
```

`meta.json` is flat and small:

```json
{"agentType":"general-purpose","description":"...","toolUseId":"toolu_...","spawnDepth":1,"model":"haiku"}
```

`parentAgentId` appears only at `spawnDepth >= 2`. Subagents can nest, confirmed
by a real depth-2 record.

`/tmp/.../tasks/<agentId>.output` is a **symlink** to the real transcript, not a
copy. That is why reading it overflows context: it is the whole JSONL.

`agentId` (not the Anthropic `tool_use_id`) is the key for `SendMessage`, the
transcript filenames, and the notification `<task-id>`.

Subagent transcripts live in separate files, so **main-conversation compaction
does not affect them**. Cleanup follows `cleanupPeriodDays`, default 30.

## Continuation

`SendMessage` with the agent's id or name resumes it. A **completed** subagent
that receives one auto-resumes in the background with no new `Agent` call.
Resumed subagents retain full history including all prior tool calls and
results.

Guardrails worth knowing:

- A send to a name that now resolves to a different agent is refused rather than
  misdelivered.
- No message from any agent counts as approval for a pending permission prompt,
  and no agent message can change permission settings, CLAUDE.md, or config.
- An agent you stopped yourself does not auto-resume; it returns a refusal.

## Frontmatter schema

Only `name` and `description` are required.

| Field | Notes |
| --- | --- |
| `name` | unique, lowercase and hyphens |
| `description` | required; **this alone drives auto-delegation**, there is no proactive flag |
| `tools` | allowlist; omit to inherit everything available to subagents |
| `disallowedTools` | denylist; applied before `tools` when both are set |
| `model` | `sonnet`/`opus`/`haiku`/`fable`/full id/`inherit` (default) |
| `permissionMode` | `default`/`acceptEdits`/`auto`/`dontAsk`/`bypassPermissions`/`plan`/`manual` |
| `maxTurns` | turn cap |
| `skills` | preloads full skill content at startup |
| `mcpServers` | subagent-scoped MCP servers, inline or by name |
| `hooks` | subagent-scoped lifecycle hooks (`Stop` converts to `SubagentStop`) |
| `memory` | `user`/`project`/`local` persistent memory dir |
| `background` | force background regardless of what the caller requests |
| `effort` | `low`/`medium`/`high`/`xhigh`/`max` |
| `isolation` | only `worktree` is documented |
| `color` | display only |
| `initialPrompt` | only used when run as main session via `--agent`, ignored as a subagent |

Notes:

- `skills:` **preloads**, it is not access control. Without it a subagent can
  still discover and invoke other skills at runtime. Skills marked
  `disable-model-invocation: true` cannot be preloaded.
- If every entry in `tools:` fails to resolve, the spawn errors with
  `Agent would be spawned with zero tools` rather than launching toolless.
- Subagents always lose a fixed set regardless of `tools:`: `AskUserQuestion`,
  `EndConversation`, `EnterPlanMode`, `ExitPlanMode` (unless
  `permissionMode: plan`), `ScheduleWakeup`, `TaskOutput`, `WaitForMcpServers`,
  `Workflow`, and `Agent` at the depth limit.
- **Background subagents get a further reduced built-in tool set.** `Bash` is
  still included, which is what matters here.

## Plugin agents are strictly weaker than user agents

Plugin agents and user agents go through two different parser functions, with
real asymmetries enforced in code rather than merely documented. The plugin-agent
parser explicitly checks for `permissionMode`, `hooks`, and `mcpServers`, logs a
warning naming the offending file and field, and drops them, directing the author
to `.claude/agents/` for that level of control.

Plugin agents therefore silently lose `permissionMode`, `hooks`, and
`mcpServers` in effect, even though the frontmatter parses. They
also recognise only `isolation: worktree` and drop `remote` with no warning,
whereas the user-agent parser at least validates it.

Both docs and source agree on this. So **a user-defined agent in
`~/.claude/agents/` is the more capable option**, and `permissionMode` is the
deciding field for anything that shells out unattended.

Registration and namespacing, for reference:

- `agents/` is a scanned convention directory. `plugin.json` may add extra paths
  but need not enumerate agents. The codex plugin declares none and is picked up
  by convention.
- Namespace is always `plugin:name`, built as
  `[pluginName, ...subdirs, frontmatterNameOrFilename].join(":")`.
  Anthropic's own `plugin-dev` skill claims top-level plugin agents get no
  prefix. The source and the live agent list both contradict it. Treat that doc
  as wrong.

## The registry is flat and merged

The registry unions built-in, plugin, userSettings, projectSettings,
flagSettings, and policySettings agents into one map keyed by agent type, sorted
alphabetically.
That is the list surfaced to the model and shown in the fleet view.

A user-defined agent is therefore a genuine peer of the built-ins, not a
second-class entry. Built-in types are hardcoded in the binary, not files. `~/.claude/agents/`
may not exist until you create it.

## What the fleet view shows

Observed live, not documented:

- One row per agent, labelled by **agent type** (the `subagent_type` argument),
  with the run's `description` beside it.
- Live elapsed time and token counters.
- Ctrl+B promotes a running foreground agent to background.
- Participation in auto mode and the monitor count.

A backgrounded Bash task gets no row. It is an anonymous shell job.

Minor wrinkle: the launch-time line and the settled fleet view render the type
label differently (one showed `Agent`, the other `general-purpose`, same run).
The label is not a stable identity mid-flight.

## Subagent output is scanned for injection

Since 2.1.210 the harness escapes text in a subagent's report that imitates
harness syntax (control tags, `Human:`/`Assistant:` turn markers) and prepends
a marker line such as:

```
[harness: subagent output matched instruction-shaped pattern(s): settings-json]
```

Content is never removed or reworded. All three research agents in this session
tripped it, purely from quoting config and tag names. Expect it when an agent
reports on config or harness internals, and treat flagged text as a finding to
relay, not an instruction to follow.

## System prompt assembly

For a non-fork subagent, initial context is:

1. Its own system prompt (markdown body) plus harness-appended environment
   details. Not the full Claude Code system prompt.
2. The delegation prompt from the parent. **No parent history, no prior tool
   results.**
3. CLAUDE.md hierarchy (skipped by built-in `Explore` and `Plan`).
4. A git-status snapshot taken at parent-session start.
5. Preloaded `skills:` content.
6. A sibling roster, only if the subagent has `SendMessage`.

A fork (`/subtask`) is the exception and inherits the whole parent conversation.

No system-prompt record appears in any subagent `.jsonl`, so it is passed via
the API `system` parameter and never persisted. Tools and skills arrive as
runtime `attachment` records mid-transcript
(`deferred_tools_delta`, `skill_listing`), not baked in upfront.

## isolation: remote does not work in this build

Docs list only `worktree`. The binary throws
`agent({isolation:'remote'}) is not available in this build` regardless of agent
source. The plugin-vs-user parity gap on `remote` is currently unobservable.

`isolation: worktree` is real: temporary git worktree branched from the default
base ref (not parent HEAD), Bash pinned inside it, `git worktree lock` held for
the duration, auto-removed if unchanged.

## The hard constraint for a Codex agent

**There are no arbitrary per-dispatch parameters.** The `Agent` tool accepts
only `subagent_type`, `prompt`, `description`, `model`, `isolation`, and
`run_in_background`. And `model` sets the **Claude wrapper's** model, not
Codex's.

So Codex's model, sandbox, and effort cannot be passed as structured arguments.
They must come from either:

- the agent definition's frontmatter and body (fixed defaults), or
- directives written into the prompt text, parsed by the wrapper.

This is the main thing that shapes the design, and it means "free model pick"
has to be expressed in prose the wrapper interprets.

## Design implications, collected

1. Build it as a **user agent** in `~/.claude/agents/`, not a plugin agent.
   `permissionMode` is the deciding capability.
2. The body **detaches** `codex exec` with `setsid`, then blocks in foreground
   `wait` calls each under the 10 minute cap. A background Bash child does not
   work: it is killed when the agent's turn ends, as shown above.
3. `codex exec -o <file>` writes the final answer to disk, so the agent returns
   a bounded summary and a path rather than dumping 36 KB into context.
4. `SendMessage` continuation maps to `codex exec resume <SESSION_ID>`, and the
   resumed agent still has its own history, so it knows which session id to
   resume. This is strictly better than the plugin's racy `--resume-last`.
5. Model, sandbox, and effort must be parsed from prompt text or fixed in
   frontmatter. There is no per-call parameter channel.
6. `description` is the only lever for proactive auto-delegation, so it needs to
   be written deliberately.
