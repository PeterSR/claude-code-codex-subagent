# Codex Plugin Internals: What The Official Plugin Can And Cannot Do

Date: 2026-07-28
Plugin version inspected: `openai-codex/codex/1.0.6`
Codex CLI version: `codex-cli 0.145.0`

Background for this project. Earlier observation logs, not included here,
recorded *what* the official plugin does when driven from Claude Code. This one
records *why*, read from the plugin source, plus the capability ceiling that
behaviour runs into.

Goal driving the investigation: make Codex feel like a first-class Claude Code
subagent, with free choice of model and sandbox, not a fire-and-forget rescue
button.

## The plugin is designed for a human in the loop

This is the single most clarifying finding, and it is explicit in the source
rather than inferred.

`commands/status.md`, `commands/result.md`, and `commands/cancel.md` all carry:

```yaml
disable-model-invocation: true
```

The model cannot call them. They are human-only slash commands.

`commands/rescue.md` and `agents/codex-rescue.md` then forbid the subagent from
doing lifecycle work at all:

> Do not ask the subagent to inspect files, monitor progress, poll
> `/codex:status`, fetch `/codex:result`, call `/codex:cancel`, summarize
> output, or do follow-up work of its own.

Put together, the intended flow is:

1. Model dispatches via `codex:codex-rescue`.
2. **A human types `/codex:status`, then `/codex:result`.**

That is a coherent design. It is just built around a person driving the
lifecycle. It is not built for an agent orchestrating several Codex jobs across
a multi-phase refactor.

So the earlier conclusion, "the coordinator owns the whole lifecycle", was not a
workaround discovered in spite of the plugin. It is the plugin's own
architecture, and the coordinator in question was meant to be a human, not
Claude.

Corollary worth stating plainly: for the lifecycle there is nothing to
"bypass". The plugin has closed that door to the model deliberately. Bash
against `codex-companion.mjs` is the only model-reachable path.

## Where the old --fresh vs --resume contradiction came from

Earlier observation logs recorded that `--fresh` blocked and
returned the full answer inline, while `--resume` returned a job id to poll, and
flagged it as one data point each way.

The cause is in `agents/codex-rescue.md:23-24`:

> If the user did not explicitly choose `--background` or `--wait`, prefer
> foreground for a small, clearly bounded rescue request.
> If the user did not explicitly choose `--background` or `--wait` and the task
> looks complicated, open-ended, multi-step, or likely to keep Codex running for
> a long time, prefer background execution.

The return shape is decided by a Sonnet judgement call about how hard the task
looks. Same command, two shapes, no way to predict which. Passing `--background`
or `--wait` explicitly removes the ambiguity entirely.

This also means a job the forwarder judges "simple" will come back with no job
id at all, which breaks any orchestration that expects to parse one.

## Correction to the earlier handoff-delay claim

The 41 to 87 second handoff recorded in
earlier observation logs is **not** purely the Sonnet
forwarder turn. It is the forwarder turn plus Codex app-server broker startup.
`scripts/lib/codex.mjs` `ensureBrokerSession` spins up a shared app-server on
the first call in a workspace and reuses it afterwards.

Going direct removes the model turn only. The first job in a session still pays
broker startup. Expect a smaller win than "remove the whole handoff".

## The capability ceiling

`codex-companion.mjs:491`:

```js
sandbox: request.write ? "workspace-write" : "read-only"
```

`scripts/lib/codex.mjs:67-68`:

```js
approvalPolicy: options.approvalPolicy ?? "never",
sandbox: options.sandbox ?? "read-only",
```

Sandbox is a binary derived from `--write`. Approval policy is hardcoded.

What the companion exposes: `--model`, `--effort`, `--write`, `--background`,
`--resume-last`, `--fresh`.

What it does **not** expose, all of which `codex exec` supports directly:

| Capability | `codex exec` flag | Why it matters here |
| --- | --- | --- |
| Third sandbox mode | `-s danger-full-access` | Companion caps at `workspace-write` |
| Approval policy | via `-c` | Hardcoded `never` |
| Arbitrary config override | `-c key=value` | Notably `sandbox_workspace_write.network_access` |
| Config profiles | `-p, --profile` | Layer a named config |
| Final answer to a file | `-o, --output-last-message <FILE>` | No result-fetch step, no big context dump |
| Structured output | `--output-schema <FILE>` | Typed findings instead of prose to reconcile |
| Resume by id | `codex exec resume <SESSION_ID>` | `--resume-last` is racy under parallelism |
| Explicit working root | `-C, --cd <DIR>` | Decouples job state from shell cwd |
| Extra writable dirs | `--add-dir <DIR>` | Multi-root work |
| Run outside a repo | `--skip-git-repo-check` | Target need not be a git repo |
| Local/OSS models | `--oss`, `--local-provider` | Not reachable via companion |
| Images | `-i, --image` | Not reachable via companion |
| Event stream | `--json` | JSONL events for progress |

The companion drives the **app-server broker**, not `codex exec`. That is where
it gets streaming progress and thread reuse, and it is also why its surface is
narrower: it exposes what the broker protocol was wired for.

The network restriction observed in earlier Go-project testing ("no network, `go get`
and `proxy.golang.org` and `github.com` all fail") is a consequence of
`workspace-write` defaults. `-c sandbox_workspace_write.network_access=true`
addresses it, and there is no way to ask the companion for that.

## State layout

Per-workspace, keyed by a slug plus hash of cwd (`scripts/lib/state.mjs:29-51`):

```
~/.claude/plugins/data/codex-openai-codex/state/<slug>-<hash>/
  state.json      # job index, pruned to MAX_JOBS = 50
  jobs/<id>.json  # per-job record
  jobs/<id>.log   # progress log
```

Two practical consequences:

- Job state follows **cwd**. Dispatching from different directories silently
  splits the job history. `codex exec -C <dir>` makes the root explicit instead.
- Polling should read `jobs/<id>.json` directly. That is more reliable than
  grepping `status` text output, which was the source of the "matches every
  historical job" trap in the earlier notes.

## Where defaults come from

Because the plugin leaves model and effort unset by default, every unflagged
call inherits whatever `~/.codex/config.toml` holds. That file is therefore the
real default-setting lever for the official path.

Worth checking your own config for a `[notice.model_migrations]` table. A model
label can be deprecated and silently redirected to a newer one, so the name in
the config is not necessarily the model being served.

Model names available at the time of writing (2026-07-28): `gpt-5.4`,
`gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`. The
plugin additionally maps `spark` to `gpt-5.3-codex-spark`. Check
`~/.codex/models_cache.json` for the current list.

## What "native feeling" actually means

Established from the Claude Code fleet view during this session, not from docs.

A dispatched subagent gets:

- a row in the agent tree, labelled by its **agent type** (the `subagent_type`
  argument), with the run's short description beside it
- live elapsed time and token counters
- interactive management, including Ctrl+B to background a running foreground
  agent mid-flight
- participation in auto mode and the monitor count
- a completion notification back to the parent

A backgrounded Bash task gets none of this. It is an anonymous shell job.

This is the reason a Bash wrapper is the wrong *interface*, however good it is
as an *implementation*. Optimising the lifecycle while discarding the fleet
integration trades away the thing that makes delegation feel natural.

Minor observation: the launch-time line and the settled fleet view render the
type label differently (one showed `Agent`, the other `general-purpose`, same
run). The label is not a stable identity mid-flight.

## Design direction being pursued

A custom agent definition whose body drives `codex exec` directly and
**blocks** for the real duration of the Codex run, returning Codex's answer as
the agent's final report.

Why blocking matters: `codex:codex-rescue` returns a job id in roughly 60
seconds while Codex keeps working for another 10 minutes. The fleet row dies
long before the work does, so the elapsed timer, the completion notification,
and Ctrl+B all refer to the wrong thing. A blocking body makes all three mean
what they appear to mean.

Known constraint to solve: the Bash tool caps at 600000 ms (10 minutes), and
observed Codex jobs ran 6 to 12+ minutes. The agent body cannot be one naive
blocking call. It needs an internal background-and-poll loop. That is ugly
inside the agent and invisible from outside, and it does not compromise the
interface.

Open questions at time of writing, under investigation:

- Whether a custom agent can take per-dispatch parameters, so model and sandbox
  are chosen at call time rather than baked into the definition.
- Whether `SendMessage` continuation preserves enough to resume the correct
  Codex session id.
- Whether a plugin-defined agent has full parity with a user-defined one.

## Standing recommendation regardless of outcome

Keep the official plugin installed and untouched for one-shot, human-driven
rescue. It is good at that, and `/codex:status` and `/codex:result` remain
useful to a human even if the model cannot call them. Anything built here should
add an orchestration lane beside it, not replace it.
