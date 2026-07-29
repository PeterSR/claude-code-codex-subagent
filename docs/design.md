# Design

Why this is built the way it is. Each decision below was forced by something
concrete; the constraint is stated with the decision so it can be re-evaluated
if the constraint changes.

## Runs are detached, not backgrounded

**Constraint:** a subagent's background Bash child is killed when the agent's
turn ends.

The first implementation launched Codex with `run_in_background: true` and ended
the turn, expecting the harness to re-invoke the agent when the child exited.
Instead the run was killed mid-flight: the event stream stopped after two items,
no answer file was written, and no process survived.

**Design:** `start` spawns a detached supervisor (`detached: true` plus
`unref()`), which owns the Codex process and publishes a completion marker by
atomic rename. The agent then blocks in foreground `wait` calls, each sized
under the Bash tool's 600000 ms cap, re-entering as often as needed.

Two consequences worth keeping:

- Long runs work. Codex jobs of 10+ minutes are normal; a single blocking call
  could not survive them.
- The run outlives the agent. An agent that dies, is interrupted, or is
  restarted leaves a recoverable run directory that `wait` can be pointed at
  from anywhere.

## It installs as a user agent, not a plugin

**Constraint:** Claude Code's loader silently drops `permissionMode`, `hooks`,
and `mcpServers` from plugin-provided agents.

`permissionMode` is load-bearing here. Without it an unattended dispatch can
stall on a permission prompt rather than running, and the obvious workaround of
allowlisting the launcher path is fragile because a plugin's cache path contains
its version number.

Everything else about a plugin agent is equivalent, including the fleet-view row
and proactive auto-delegation. The gap is those three fields, not nativeness.

**Design:** ship on npm and write the agent into `~/.claude/agents/`.

A companion plugin remains sensible for things that lose nothing by being in a
plugin: slash commands for inspecting run directories, or a skill covering
multi-job orchestration. Neither is an agent. Not built.

## Codex settings are parsed from prose

**Constraint:** the `Agent` tool accepts only `subagent_type`, `prompt`,
`description`, `model`, `isolation`, and `run_in_background`. Its `model` sets
the wrapper's model, not Codex's. There is no channel for arbitrary parameters.

**Design:** the wrapper reads sandbox, model, and effort out of the request text
and maps them to launcher flags. Reliable in practice, but it is interpretation
rather than argument passing, and it is listed as a limitation in the README
because of that.

## The prompt is passed as a file

**Constraint:** heredocs are shell-specific and would not survive PowerShell.

**Design:** the agent writes the composed prompt to a file and passes
`--prompt-file`. This removes every quoting and escaping hazard as a side
effect, so it is better on POSIX too, not merely a portability concession.

## The launcher is separate from the agent

The agent definition is a prompt; the launcher is a program. Keeping them apart
means the launcher is independently testable without a model in the loop, which
is where the entire 33-case test suite lives. It is also usable directly, with
no Claude Code involved.

## The wrapper may never answer on its own

**Constraint:** told to answer a trivial question, the wrapper did so from its
own knowledge and explained that the question did not merit a Codex run.

That defeats the tool. Whoever dispatches this agent wants Codex's answer rather
than Sonnet's, and receives no signal that they got a substitute.

**Design:** the instructions state that no exception exists, and that replying
without a Codex run is a failure regardless of whether the reply was correct.
The only thing returnable without a run is a failure report.

## Guardrails are injected into every prompt

Four blocks are appended to every dispatch: keep changes scoped and do not run
repo-wide formatters; do not invent APIs, stop and report a blocker instead;
emit a complete diff if the sandbox turns out read-only; verify before
finalising.

Each corresponds to an observed failure, including a run that reformatted nine
unrelated migration files, and a reported test pass on a run where the patch had
never been applied. They are on by default because the failures they prevent are
things one knows but does not repeat on every dispatch.

## Safety choices in the installer

- Generated files carry an ownership marker, so uninstall never deletes a
  `codex.md` written by hand, and install never silently replaces one.
- `uninstall` does not prompt: one file, created by this package, free to
  reinstall.
- `purge` prints an itemised plan and asks, because run directories hold prompts
  and Codex's answers. It refuses outright when there is no terminal to confirm
  at.

This mirrors Claude Code's own convention, where confirmation is gated by blast
radius rather than by whether an operation deletes something.
