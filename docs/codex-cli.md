# codex exec

Behaviour of the OpenAI Codex CLI that this launcher relies on or works around.
Verified against `codex-cli 0.145.0` by direct invocation.

## Flags used, and why

| Flag | Why it matters |
| --- | --- |
| `-o, --output-last-message <FILE>` | Writes only the final answer. Large results never enter the conversation; the wrapper reports a bounded summary plus a path. |
| `--json` | JSONL event stream. `thread.started` carries `thread_id`, the resume handle. |
| `-s, --sandbox` | All three modes, including `danger-full-access`. |
| `-c key=value` | Reaches any config key. Used for network access, reasoning effort, and the sandbox on resume. |
| `-C, --cd <DIR>` | Pins the working root explicitly rather than inheriting the shell's. |
| `--output-schema <FILE>` | Structured JSON output. |
| `--skip-git-repo-check` | The target need not be a git repository. |

## Network access

`workspace-write` blocks the network by default, which is what makes dependency
fetches fail inside a run. Enable it explicitly:

```
-s workspace-write -c sandbox_workspace_write.network_access=true
```

Verified with a live request returning HTTP 200 from inside a sandboxed run.
This is the launcher's default, since the alternative is pre-staging every
dependency from outside.

## stdin must be redirected

Without a redirect, `codex exec` prints `Reading additional input from stdin...`
and waits. In a detached run that is an indefinite hang. The launcher always
supplies the prompt on stdin from a file.

## Resume has three sharp edges

`codex exec resume <SESSION_ID>` retains full conversation context, verified by
round-tripping a value across separate invocations. But:

1. **It accepts no `-s/--sandbox`.** Passing one fails with
   `error: unexpected argument '-s' found`. This is the real explanation for
   read-only failures on resumed threads; it is not a policy negotiated at
   thread creation.
2. **`-c sandbox_mode=workspace-write` does override it.** A thread created
   read-only can be resumed with write access. Abandoning the thread and
   starting fresh is unnecessary.
3. **It accepts no `-C/--cd`.** The working root stays pinned to wherever the
   thread was born, so a resumed thread writes there rather than in the current
   directory. Verified by resuming from a different directory and observing
   where the file landed.

Resuming by explicit id is also safer than the official plugin's
`--resume-last`, which is racy once runs overlap.

## Structured output

`--output-schema` takes a JSON Schema file. Every property must appear in
`required`, and every object needs `additionalProperties: false`, or Codex
rejects the schema. `schemas/findings.schema.json` is a working example.

Useful when several runs must be compared or merged, since prose answers from
parallel runs contradict each other in ways that are tedious to reconcile by
hand.

## Model selection

Unset inherits `~/.codex/config.toml`. Worth checking that file for a
`[notice.model_migrations]` table: a label can be silently redirected to a newer
model, so the configured name is not necessarily what serves the request.

Models available at the time of writing: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`,
`gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`. Check
`~/.codex/models_cache.json` for the current list.

## Trust its output, not its self-assessment

Codex has been observed reporting a cached test pass on a run where the patch
had never been applied. Treat any claim that verification succeeded as a claim,
and read the diff.
