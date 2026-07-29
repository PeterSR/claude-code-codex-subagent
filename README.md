# codex subagent for Claude Code

Run OpenAI Codex as a first-class Claude Code subagent.

```
Agent(subagent_type: "codex", prompt: "read only, gpt-5.6-sol, high effort

Research how the odometer module couples to the vehicle base class.")
```

It behaves like any other subagent: it gets a row in the fleet view with a live
timer, you can background it with Ctrl+B, dispatch several in parallel, and
continue one with `SendMessage`. Codex model, reasoning effort, and sandbox
policy are chosen in plain prose in the prompt.

## Why this exists

OpenAI ships an [official Codex plugin](https://github.com/openai/codex) for
Claude Code, and it is good at what it is designed for: one-shot rescue with a
human in the loop. Its `status`, `result`, and `cancel` commands are marked
`disable-model-invocation: true`, so the model literally cannot call them, and
its rescue subagent is forbidden from polling or fetching. The intended flow is
that a person types `/codex:status` and then `/codex:result`.

That leaves a gap when an agent, not a person, is orchestrating: several Codex
jobs across a multi-phase task, running for many minutes, with results that need
collecting and comparing. This project fills that gap. It also lifts a
capability ceiling: the official runtime derives the sandbox from a single
boolean (`workspace-write` or `read-only`) and hardcodes the approval policy, so
`danger-full-access`, network access, config overrides, structured output, and
resume-by-id are all out of reach.

Keep the official plugin installed. `/codex:rescue` remains the right tool for a
quick human-driven ask. This adds a second lane beside it.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- [Codex CLI](https://github.com/openai/codex) on `PATH`, authenticated
  (`npm install -g @openai/codex`, then run `codex` once to sign in)
- `setsid` (util-linux), used to detach runs
- Bash 4+

Developed against `codex-cli 0.145.0` and Claude Code 2.1.220 on Linux. macOS
should work but `setsid` is not present by default there; see Limitations.

## Install

```bash
git clone https://github.com/<you>/claude-code-codex-subagent
cd claude-code-codex-subagent
./install.sh
```

This writes `~/.claude/agents/codex.md` with this checkout's absolute paths
baked in, so nothing depends on `PATH`. Then restart Claude Code (or run
`/reload-plugins`) so the agent registry picks it up.

```bash
./install.sh --check       # verify prerequisites only
./install.sh --uninstall   # remove the agent
```

Honours `CLAUDE_CONFIG_DIR` if you have set it.

## Usage

Write what you want in prose. The wrapper reads intent out of it.

```
Agent(subagent_type: "codex", prompt: "
Read only, model gpt-5.6-sol, high effort.
Working directory /path/to/repo.

Review src/auth for authentication bypasses. For each finding give the line,
what breaks, and a concrete failing input.
")
```

Defaults: sandbox `workspace-write` with network enabled, model and effort
inherited from `~/.codex/config.toml`. Requests that read as investigation,
review, or diagnosis are switched to `read-only` automatically.

**Structured output.** Ask for JSON and the agent passes a schema, so Codex
returns machine-readable findings instead of prose. A `findings` schema ships in
`schemas/`, carrying severity, confidence, file, line, detail, and failure
scenario. This is what makes several parallel Codex runs mergeable rather than
four walls of text that contradict each other.

**Continuation.** `SendMessage` to the agent resumes the same Codex thread by
id. This is precise where the official plugin's `--resume-last` is racy once
runs overlap.

**Guardrails.** Every dispatch appends blocks telling Codex to keep changes
scoped, not to run repo-wide formatters, not to invent APIs, to emit a full diff
if the sandbox turns out read-only, and to verify before finalising. Each one
exists because of an observed failure.

### Using the launcher directly

The launcher is a standalone Bash script and needs no Claude Code at all.

```bash
bin/codex-subagent run --workdir /repo --sandbox read-only --model gpt-5.6-sol <<'EOF'
your prompt
EOF
```

Or split it, which is what the agent does:

```bash
RD=$(bin/codex-subagent start --workdir /repo --sandbox read-only <<'EOF'
your prompt
EOF
)
bin/codex-subagent wait "$RD" --timeout-sec 540   # exit 75 means call again
```

Options for `start` and `run`: `--sandbox`, `--no-network`, `--model`,
`--effort`, `--workdir`, `--resume <thread-id>`, `--schema <file>`,
`--prompt-file <file>`, `--run-dir`. `wait` takes a run directory and
`--timeout-sec`.

Exit codes: `0` success, `64` usage error, `70` the run died without writing a
completion marker, `75` not finished yet, otherwise Codex's own exit code.

Run artifacts land in `~/.cache/codex-subagent/<timestamp>-<pid>/` as
`prompt.txt`, `command.txt`, `events.jsonl`, `stderr.txt`, `answer.md`, `pid`,
`exit`. Nothing is cleaned up automatically.

## How it works

A Claude Code subagent is a Claude instance, so this is a thin Sonnet wrapper
that shells out to `codex exec`. Two design decisions carry the whole thing.

**Runs are detached, not backgrounded.** A subagent's background Bash child is
killed when its turn ends. That was the first implementation and it lost a Codex
run mid-flight with no output. Instead `start` launches Codex under `setsid`, in
its own session, and returns a run directory immediately. The agent then blocks
in foreground `wait` calls, each under the Bash tool's 600000 ms cap, re-entering
as often as needed. A useful side effect: the work is no longer coupled to the
agent's lifetime, so an agent that dies or is interrupted leaves a recoverable
run.

**It is a user agent, not a plugin.** Claude Code's loader silently drops
`permissionMode`, `hooks`, and `mcpServers` from plugin-provided agents. Since
this agent shells out unattended, `permissionMode` matters, so it installs into
`~/.claude/agents/` instead of shipping as a plugin.

`codex exec` gives several things the official runtime does not expose:
`-o/--output-last-message` writes only the final answer, so large results never
enter the conversation; `--output-schema` gives structured output;
`resume <SESSION_ID>` is addressable rather than "most recent"; `-C/--cd` pins
the working root; and `-c` reaches any config key, including
`sandbox_workspace_write.network_access`.

`docs/` contains the research this was built from: how Claude Code subagents
work at the harness level, and what the official Codex plugin can and cannot do.

## Limitations

- **No per-dispatch parameters.** Claude Code's `Agent` tool takes only
  `subagent_type`, `prompt`, `description`, `model`, `isolation`, and
  `run_in_background`, and its `model` sets the wrapper's model, not Codex's. So
  Codex settings have to be stated in prose and parsed by the wrapper. It is
  reliable in practice but it is interpretation, not argument passing.
- **Resume cannot change the working root.** `codex exec resume` has no `-C`, so
  a resumed thread writes wherever the thread was born, not your current
  directory.
- **No cleanup.** Run directories accumulate under `~/.cache/codex-subagent/`.
- **macOS needs setsid.** Not present by default. `brew install util-linux`, or
  substitute another detach mechanism.
- **Agent changes need a reload.** The registry loads at session start, so
  editing the installed agent mid-session has no effect. Testing tip:
  `claude -p --allowedTools "Agent,Bash,Read" "Dispatch the codex subagent ..."`
  gets a fresh registry per invocation.
- **Trust but verify.** Codex has been observed reporting tests passing on a run
  where the patch was never applied. The agent is instructed to relay such
  claims as claims. Read the diff.

## License

MIT, see [LICENSE](LICENSE).

Not affiliated with OpenAI or Anthropic.
